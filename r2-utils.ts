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
  }));

  return `${PUBLIC_URL}/${key}`;
}

// ── Weekly event storage ─────────────────────────────────────────────
function getISOWeekKey(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = date.getDay() || 7; // Make Sunday = 7
  date.setDate(date.getDate() + 4 - dayOfWeek); // Move to Thursday of the week
  const yearStart = new Date(date.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

async function getWeeklyEvents(weekKey: string): Promise<StoredEvent[]> {
  try {
    const resp = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: `events/${weekKey}.json`,
    }));
    const body = await resp.Body?.transformToString();
    return body ? JSON.parse(body) : [];
  } catch {
    return []; // File doesn't exist yet
  }
}

export async function storeEvent(event: StoredEvent): Promise<void> {
  const weekKey = getISOWeekKey(event.date ?? new Date().toISOString().split('T')[0]!);
  const events = await getWeeklyEvents(weekKey);
  events.push(event);

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `events/${weekKey}.json`,
    Body: JSON.stringify(events, null, 2),
    ContentType: 'application/json',
  }));

  console.log(`  ↳ Stored event in events/${weekKey}.json (${events.length} events total)`);
}
