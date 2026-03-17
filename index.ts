import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from 'baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { unlink } from 'fs/promises';
import { getStructuredMessage } from './message-utils.js';
import { generateEventInfo } from './event-utils.js';
import { uploadMedia, storeEvent, isDuplicate, type StoredEvent } from './r2-utils.js';

// ── Config ──────────────────────────────────────────────────────────
// Add JIDs to listen to (group or individual). Empty = listen to all.
const LISTEN_JIDS: string[] = [];
const AUTH_DIR = './auth_state';
// ─────────────────────────────────────────────────────────────────────


let activeSock: ReturnType<typeof makeWASocket> | null = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY = 120_000; // 2 minutes

function gracefulShutdown(signal: any) {
  console.log(`\n${signal} received. Closing WhatsApp connection...`);
  if (activeSock) {
    activeSock.end(undefined);
  }
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

async function startListener() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'),
    version: [2, 3000, 1033893291],
    getMessage: async () => undefined,
  });

  activeSock = sock;

  // ── Connection handling ───────────────────────────────────────────
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan this QR code with WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectAttempt = 0;
      console.log('\n✓ Connected to WhatsApp\n');
      if (LISTEN_JIDS.length === 0) {
        console.log('LISTEN_JIDS is empty — listening to ALL chats.');
      } else {
        console.log(`Listening to ${LISTEN_JIDS.length} chat(s):\n${LISTEN_JIDS.map(j => `  - ${j}`).join('\n')}\n`);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Record<string, any>)?.output?.statusCode;
      console.log(`Connection closed`);
      console.log('error: ', JSON.stringify(lastDisconnect, null, 2));

      if (statusCode === DisconnectReason.loggedOut) {
        console.log('Logged out. Delete the auth_state folder and re-run.');
        process.exit(1);
      }

      if (statusCode === DisconnectReason.restartRequired) {
        console.log('Restart required (expected after QR scan). Reconnecting...');
        startListener();
        return;
      }

      const delay = Math.min(10_000 * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY);
      reconnectAttempt++;
      console.log(`Reconnecting in ${(delay / 1000).toFixed(0)}s... (attempt ${reconnectAttempt})`);
      setTimeout(() => startListener(), delay);
    }
  });

  // ── Save credentials on update ────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── Listen for messages ───────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid;

      console.log('JID: ', remoteJid);

      // Filter by LISTEN_JIDS if configured
      if (LISTEN_JIDS.length > 0 && remoteJid && !LISTEN_JIDS.includes(remoteJid)) continue;

      const structuredMessage = await getStructuredMessage(msg);

      if (!structuredMessage) continue;

      console.log(JSON.stringify(structuredMessage, null, 2));

      // Extract event info via LLM
      try {
        const eventInfo = await generateEventInfo(structuredMessage);

        if (eventInfo) {
          console.log('\n✓ Event detected:');
          console.log(JSON.stringify(eventInfo, null, 2));

          // Check for duplicates before uploading media
          if (await isDuplicate(structuredMessage.message!, eventInfo.date)) {
            console.log('  ↳ Duplicate event, skipping.');
            if (structuredMessage.imageUrl) await unlink(structuredMessage.imageUrl).catch(() => { });
            if (structuredMessage.videoUrl) await unlink(structuredMessage.videoUrl).catch(() => { });
          } else {
            // Upload media to R2 and get public URLs
            let imageUrl: string | null = null;
            let videoUrl: string | null = null;

            if (structuredMessage.imageUrl) {
              try {
                imageUrl = await uploadMedia(structuredMessage.imageUrl);
                console.log(`  ↳ Image uploaded: ${imageUrl}`);
              } catch (err: any) {
                console.error(`  ↳ Image upload failed: ${err.message}`);
              } finally {
                await unlink(structuredMessage.imageUrl).catch(() => { });
              }
            }

            if (structuredMessage.videoUrl) {
              try {
                videoUrl = await uploadMedia(structuredMessage.videoUrl);
                console.log(`  ↳ Video uploaded: ${videoUrl}`);
              } catch (err: any) {
                console.error(`  ↳ Video upload failed: ${err.message}`);
              } finally {
                await unlink(structuredMessage.videoUrl).catch(() => { });
              }
            }

            // Store event with raw message and media URLs
            const storedEvent: StoredEvent = { ...eventInfo, message: structuredMessage.message!, imageUrl, videoUrl };
            try {
              await storeEvent(storedEvent);
            } catch (err: any) {
              console.error(`  ↳ Failed to store event in R2: ${err.message}`);
            }
          }
        } else {
          console.log('  ↳ Not an event, skipping.');
        }
      } catch (err: any) {
        console.error(`  ↳ LLM extraction failed: ${err.message}`);
      }
    }
  });
}

startListener().catch(console.error);
