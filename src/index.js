import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage } from 'mimetext';

const config = {
  websites: [
    'https://archive.fovos.jp',
    'https://cloud.fovos.jp',
    'https://dashbord.fovos.jp',
    'https://drawio.fovos.jp',
    'https://influx.fovos.jp',
    'https://phobos.fovos.jp',
    'https://speed.fovos.jp',
    'https://wol.飛鳥.jp',
    'https://飛鳥.jp',
    'https://xn--x41a433c.飛鳥.jp',
    'https://deimos.fovos.jp',
    'https://pg.fovos.jp',
    'https://postgres.fovos.jp',
    'https://metabase.fovos.jp',
    'https://link.飛鳥.jp',
    'https://coolify.fovos.jp',
    'https://fovos.jp'
  ],

  emailInterval: 36000000,             // 10時間ごとに状態レポートを送信
  discordReportInterval: 3600000,       // Discord通知を60分ごとに実行
  maxRetries: 3,                       // 接続失敗時の再試行回数
  retryDelayBase: 5000,                // 再試行間隔のベース（5秒）
  retryDelayExponent: 2,               // 再試行間隔の指数（指数バックオフ）
  senderName: 'TrueNAS Monitor',      // 送信者名
  senderEmail: 'atsoumkya@gmail.com', // 通知メール送信元
  recipientEmail: 'h.yoshitomi.a.s@gmail.com',   // 通知メール送信先
  emailSubjectPrefix: '[FOVOS Monitor]', // メール件名プレフィックス
  testMode: false                      // テストモード無効
};

async function checkWebsiteUptime(scheduledTime, env) {
	let statusReport = '';
	let hasDownWebsites = false;

	const websitePromises = config.websites.map(async (websiteUrl) => {
		let retries = 0;
		let isWebsiteUp = false;
		let errorMessage = '';

		for (let i = 0; i < config.maxRetries && !isWebsiteUp; i++) {
			try {
				const response = await fetch(websiteUrl);
				const timestamp = formatTimestamp(scheduledTime);

				if (!response.ok) {
					const logEntry = {
						website: websiteUrl,
						status: 'down',
						statusCode: response.status,
						timestamp: timestamp,
					};
					await saveLogEntryToKV(logEntry, env);

					if (response.status === 404 || response.status === 503) {
						console.log(`[${timestamp}] ${websiteUrl} is down. Status code: ${response.status}`);
						statusReport += `[${timestamp}] ${websiteUrl} is down. Status code: ${response.status}\n`;
						await sendWebsiteDownEmail(websiteUrl, response.status, timestamp, env);
						hasDownWebsites = true;
					} else {
						console.log(`[${timestamp}] ${websiteUrl} returned an error. Status code: ${response.status}`);
						statusReport += `[${timestamp}] ${websiteUrl} returned an error. Status code: ${response.status}\n`;
					}
				} else {
					console.log(`[${timestamp}] ${websiteUrl} is up`);
					statusReport += `[${timestamp}] ${websiteUrl} is up`;
					isWebsiteUp = true;
				}
			} catch (error) {
				console.error(`[${formatTimestamp(scheduledTime)}] Error checking ${websiteUrl} uptime:`, error);
				statusReport += `[${formatTimestamp(scheduledTime)}] Error checking ${websiteUrl} uptime: ${error.message}`;
				errorMessage = error.stack;
			}

			retries++;
			if (!isWebsiteUp && retries < config.maxRetries) {
				const delay = config.retryDelayBase * Math.pow(config.retryDelayExponent, i);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}

		if (retries > 1) {
			statusReport += ` (retries: ${retries})\n`;
		} else {
			statusReport += '\n';
		}

		if (errorMessage) {
			statusReport += `[${formatTimestamp(scheduledTime)}] ${websiteUrl} error: ${errorMessage}\n`;
		}

		return { websiteUrl, retries, errorMessage };
	});

	await Promise.all(websitePromises);

	const lastEmailSentTime = await getLastEmailSentTime(env);
	const currentTime = Date.now();
	if (currentTime - lastEmailSentTime >= config.emailInterval) {
		await sendStatusReportEmail(statusReport, scheduledTime, env);
		await setLastEmailSentTime(currentTime, env);
	}

	const lastDiscordReportTime = await getLastDiscordReportTime(env);
	if (currentTime - lastDiscordReportTime >= config.discordReportInterval) {
		await sendStatusReportToDiscord(statusReport, scheduledTime, env);
		await setLastDiscordReportTime(currentTime, env);
	}

	if (hasDownWebsites || config.testMode) {
		await sendWebsiteDownDiscordMessage(statusReport, scheduledTime, env);
	}
}

async function getLastDiscordReportTime(env) {
	const value = await env.UPTIME_LOGS.get('lastDiscordReportTime');
	return value ? parseInt(value) : 0;
}

async function setLastDiscordReportTime(timestamp, env) {
	await env.UPTIME_LOGS.put('lastDiscordReportTime', timestamp.toString());
}

async function saveLogEntryToKV(logEntry, env) {
	const timestamp = logEntry.timestamp;
	const key = `log:${timestamp}:${logEntry.website}`;
	const value = JSON.stringify(logEntry);
	await env.UPTIME_LOGS.put(key, value);
}

async function getLastEmailSentTime(env) {
	const value = await env.UPTIME_LOGS.get('lastEmailSentTime');
	return value ? parseInt(value) : 0;
}

async function setLastEmailSentTime(timestamp, env) {
	await env.UPTIME_LOGS.put('lastEmailSentTime', timestamp.toString());
}

function formatTimestamp(timestamp) {
	const manilaTimezone = 'Asia/Manila';
	const options = {
		timeZone: manilaTimezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	};
	return new Date(timestamp).toLocaleString('en-US', options);
}

async function sendWebsiteDownEmail(websiteUrl, statusCode, timestamp, env) {
	const msg = createMimeMessage();
	msg.setSender({ name: config.senderName, addr: config.senderEmail });
	msg.setRecipient(config.recipientEmail);
	msg.setSubject(`${config.emailSubjectPrefix} Website Down: ${websiteUrl}`);
	msg.addMessage({
		contentType: 'text/plain',
		data: `The website ${websiteUrl} is down.\n\nStatus Code: ${statusCode}\nTimestamp: ${timestamp}`,
	});

	const message = new EmailMessage(config.senderEmail, config.recipientEmail, msg.asRaw());
	try {
		await env.EMAIL_BINDING.send(message);
		console.log(`Website down email sent successfully for ${websiteUrl}.`);
	} catch (error) {
		console.error(`Error sending website down email for ${websiteUrl}:`, error);
	}
}

async function sendWebsiteDownDiscordMessage(statusReport, scheduledTime, env) {
	const payload = {
		content: `Emergency: One or more websites are down!\n\nWebsite Uptime Status Report - ${formatTimestamp(
			scheduledTime
		)}\n\n${statusReport}`,
	};

	try {
		// Send message to the Discord channel via webhook
		const webhookResponse = await fetch(env.DISCORD_WEBHOOK_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});

		if (webhookResponse.ok) {
			console.log('Website down emergency message sent to Discord channel successfully.');
		} else {
			console.error('Error sending website down emergency message to Discord channel:', webhookResponse.status);
		}

		// Send direct message to the specified user
		const dmPayload = {
			content: `Emergency: One or more websites are down!\n\nWebsite Uptime Status Report - ${formatTimestamp(
				scheduledTime
			)}\n\n${statusReport}`,
		};

		const dmResponse = await fetch(`https://discord.com/api/v10/users/@me/channels`, {
			method: 'POST',
			headers: {
				Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ recipient_id: env.DISCORD_USER_ID }),
		});

		if (dmResponse.ok) {
			const dmChannel = await dmResponse.json();
			const sendMessageResponse = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
				method: 'POST',
				headers: {
					Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(dmPayload),
			});

			if (sendMessageResponse.ok) {
				console.log('Website down emergency message sent to Discord user successfully.');
			} else {
				console.error('Error sending website down emergency message to Discord user:', sendMessageResponse.status);
			}
		} else {
			console.error('Error creating DM channel:', dmResponse.status);
		}
	} catch (error) {
		console.error('Error sending website down emergency message:', error);
	}
}

async function sendStatusReportEmail(statusReport, scheduledTime, env) {
	const msg = createMimeMessage();
	msg.setSender({ name: config.senderName, addr: config.senderEmail });
	msg.setRecipient(config.recipientEmail);
	msg.setSubject(`${config.emailSubjectPrefix} Website Uptime Status Report - ${formatTimestamp(scheduledTime)}`);
	msg.addMessage({
		contentType: 'text/plain',
		data: `Here is the website uptime status report:\n\n${statusReport}`,
	});

	const message = new EmailMessage(config.senderEmail, config.recipientEmail, msg.asRaw());
	try {
		await env.EMAIL_BINDING.send(message);
		console.log('Status report email sent successfully.');
	} catch (error) {
		console.error('Error sending status report email:', error);
	}
}

async function sendStatusReportToDiscord(statusReport, scheduledTime, env) {
	const payload = {
		content: `Website Uptime Status Report - ${formatTimestamp(scheduledTime)}\n\n${statusReport}`,
	};
	try {
		const response = await fetch(env.DISCORD_WEBHOOK_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});
		if (response.ok) {
			console.log('Status report sent to Discord successfully.');
		} else {
			console.error('Error sending status report to Discord:', response.status);
		}
	} catch (error) {
		console.error('Error sending status report to Discord:', error);
	}
}

export default {
	async scheduled(controller, env) {
		const { scheduledTime } = controller;
		await checkWebsiteUptime(scheduledTime, env);
	},
};
