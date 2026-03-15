import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage } from 'baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

// ── Config ──────────────────────────────────────────────────────────
// Add JIDs to listen to (group or individual). Empty = listen to all.
const LISTEN_JIDS = [];
const AUTH_DIR = './auth_state';
const MEDIA_DIR = './downloaded_media';
// ─────────────────────────────────────────────────────────────────────

await mkdir(MEDIA_DIR, { recursive: true });

async function downloadMedia(msg, mediaMsg, type) {
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    const ext = mediaMsg.mimetype?.split('/')[1] || (type === 'image' ? 'jpg' : 'mp4');
    const filename = `${msg.key.id}.${ext}`;
    const filepath = path.join(MEDIA_DIR, filename);
    await writeFile(filepath, buffer);
    console.log(`  ↳ ${type} saved: ${filepath}`);
    return filepath;
  } catch (err) {
    console.error(`  ↳ Failed to download ${type}: ${err.message}`);
    return null;
  }
}

function parseMessage(msg) {
  const m = msg.message;

  // Skip: replies (contextInfo with quoted message)
  const contextInfo =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo;
  if (contextInfo?.quotedMessage) return null;

  // Skip: protocol messages (deletes, edits, reactions, etc.)
  if (m.protocolMessage || m.reactionMessage || m.editedMessage) return null;

  // Skip: documents, audio, stickers, contacts, locations
  if (m.documentMessage || m.audioMessage || m.stickerMessage || m.contactMessage || m.locationMessage) return null;

  const hasImage = !!m.imageMessage;
  const hasVideo = !!m.videoMessage;
  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null;

  // Determine message type
  let type;
  if (hasImage && text) type = 'image-message';
  else if (hasImage) type = 'image-only';
  else if (hasVideo && text) type = 'video-message';
  else if (hasVideo) type = 'video-only';
  else if (text) type = 'text-only';
  else return null;

  return { type, text, hasImage, hasVideo, imageMsg: m.imageMessage, videoMsg: m.videoMessage };
}

let activeSock = null;

function gracefulShutdown(signal) {
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
      console.log('\n✓ Connected to WhatsApp\n');
      if (LISTEN_JIDS.length === 0) {
        console.log('LISTEN_JIDS is empty — listening to ALL chats.');
        console.log('JIDs will be printed with each message so you can pick ones to filter.\n');
      } else {
        console.log(`Listening to ${LISTEN_JIDS.length} chat(s):\n${LISTEN_JIDS.map(j => `  - ${j}`).join('\n')}\n`);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed. Status: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log('Logged out. Delete the auth_state folder and re-run.');
        process.exit(1);
      }

      if (statusCode === DisconnectReason.restartRequired) {
        console.log('Restart required (expected after QR scan). Reconnecting...');
        startListener();
        return;
      }

      console.log('Reconnecting in 5s...');
      setTimeout(() => startListener(), 5000);
    }
  });

  // ── Save credentials on update ────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── Listen for messages ───────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid;

      // Filter by LISTEN_JIDS if configured
      if (LISTEN_JIDS.length > 0 && !LISTEN_JIDS.includes(remoteJid)) continue;

      // Skip empty protocol messages
      if (!msg.message) continue;

      const parsed = parseMessage(msg);
      if (!parsed) continue;

      // Download media if present
      let imagePath = null;
      let videoPath = null;
      if (parsed.hasImage) {
        imagePath = await downloadMedia(msg, parsed.imageMsg, 'image');
      }
      if (parsed.hasVideo) {
        videoPath = await downloadMedia(msg, parsed.videoMsg, 'video');
      }

      const structured = {
        type: parsed.type,
        message: parsed.text,
        imageUrl: imagePath,
        videoUrl: videoPath,
        sender: {
          id: msg.key.participant || remoteJid,
          name: msg.pushName || 'Unknown',
        },
      };

      console.log('─'.repeat(60));
      console.log(`Chat:    ${remoteJid}`);
      console.log(`Type:    ${structured.type}`);
      console.log(`From:    ${structured.sender.name} (${structured.sender.id})`);
      if (structured.message) console.log(`Message: ${structured.message}`);
      if (structured.imageUrl) console.log(`Image:   ${structured.imageUrl}`);
      if (structured.videoUrl) console.log(`Video:   ${structured.videoUrl}`);
      console.log('─'.repeat(60));

      // TODO: send `structured` to your processing pipeline
    }
  });
}

startListener().catch(console.error);
