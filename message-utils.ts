import { downloadMediaMessage, proto, type WAMessage } from 'baileys';
import path from 'path';
import { writeFile, mkdir } from 'fs/promises';

const MEDIA_DIR = './downloaded_media';


await mkdir(MEDIA_DIR, { recursive: true });

async function downloadMedia(msg: WAMessage, mediaMsg: any, type: 'image' | 'video') {
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    const ext = mediaMsg.mimetype?.split('/')[1] || (type === 'image' ? 'jpg' : 'mp4');
    const filename = `${msg.key.id}.${ext}`;
    const filepath = path.join(MEDIA_DIR, filename);
    await writeFile(filepath, buffer);
    console.log(`  ↳ ${type} saved: ${filepath}`);
    return filepath;
  } catch (err: any) {
    console.error(`  ↳ Failed to download ${type}: ${err.message}`);
    return null;
  }
}


interface ParsedMessage {
  type: 'image-message' | 'video-message' | 'image-only' | 'video-only' | 'text-only';
  text: string | null;
  hasImage: boolean;
  hasVideo: boolean;
  imageMsg: proto.Message.IImageMessage | null;
  videoMsg: proto.Message.IVideoMessage | null;
}

export type StructuredMessage = {
  type: ParsedMessage['type']
  message: string | null,
  imageUrl: string | null,
  videoUrl: string | null,
  sender: {
    id: string | null,
    name: string,
  },
};


function parseMessage(msg: WAMessage): ParsedMessage | null {
  const m = msg.message;

  if (!m) return null;

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
  let type: ParsedMessage['type'];
  if (hasImage && text) type = 'image-message';
  else if (hasImage) type = 'image-only';
  else if (hasVideo && text) type = 'video-message';
  else if (hasVideo) type = 'video-only';
  else if (text) type = 'text-only';
  else return null;

  return { type, text, hasImage, hasVideo, imageMsg: m.imageMessage ?? null, videoMsg: m.videoMessage ?? null };
}

export async function getStructuredMessage(msg: WAMessage): Promise<StructuredMessage | null> {
  const parsed = parseMessage(msg);

  if (!parsed) return null;

  // Download media if present
  let imagePath: string | null = null;
  let videoPath: string | null = null;
  if (parsed.hasImage) {
    imagePath = await downloadMedia(msg, parsed.imageMsg, 'image');
  }
  if (parsed.hasVideo) {
    videoPath = await downloadMedia(msg, parsed.videoMsg, 'video');
  }

  return {
    type: parsed.type,
    message: parsed.text,
    imageUrl: imagePath,
    videoUrl: videoPath,
    sender: {
      id: msg.key.participant || msg.key.remoteJid || null,
      name: msg.pushName || 'Unknown',
    },
  }
}
