import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { readFile } from 'fs/promises';
import path from 'path';
import { type EventInfo } from './event-utils.js';

// ── R2 Client ────────────────────────────────────────────────────────
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME!;
const PUBLIC_URL = process.env.R2_PUBLIC_URL!; // e.g. https://pub-xxx.r2.dev

// ── Types ────────────────────────────────────────────────────────────
export interface StoredEvent extends EventInfo {
  message: string;
  imageUrl: string | null;
  videoUrl: string | null;
}

// ── Media upload ─────────────────────────────────────────────────────
const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
};

export async function uploadMedia(localPath: string): Promise<string> {
  const filename = path.basename(localPath);
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
  const key = `media/${filename}`;

  const body = await readFile(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return `${PUBLIC_URL}/${key}`;
}

// ── Daily event storage ──────────────────────────────────────────────
export function getTodayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function getDailyEvents(dateKey: string): Promise<StoredEvent[]> {
  try {
    const resp = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: `events/${dateKey}.json`,
    }));
    const body = await resp.Body?.transformToString();
    return body ? JSON.parse(body) : [];
  } catch {
    return []; // File doesn't exist yet
  }
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function isDuplicate(message: string, date: string | null): Promise<boolean> {
  const dateKey = date ?? getTodayIST();
  const events = await getDailyEvents(dateKey);
  return events.some(e => normalize(e.message) === normalize(message));
}

export async function storeEvent(event: StoredEvent): Promise<boolean> {
  const dateKey = event.date ?? getTodayIST();
  const events = await getDailyEvents(dateKey);

  events.push(event);

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `events/${dateKey}.json`,
    Body: JSON.stringify(events, null, 2),
    ContentType: 'application/json',
    CacheControl: 'public, max-age=300',
  }));

  console.log(`  ↳ Stored event in events/${dateKey}.json (${events.length} events total)`);
  return true;
}
