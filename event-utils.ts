import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, Output } from 'ai';
import z from 'zod';
import { type StructuredMessage } from './message-utils.js';
import { openai } from '@ai-sdk/openai';

const nim = createOpenAICompatible({
  name: 'nim',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  headers: {
    Authorization: `Bearer ${process.env.NIM_API_KEY}`,
  },
});

const outputSchema = z.object({
  isEvent: z.boolean().describe('Whether the message is about an actual event, workshop, or class'),
  title: z.string().nullable().describe('The event title exactly as written in the message'),
  description: z.string().nullable().describe('The event description/details exactly as they appear in the message'),
  category: z.enum(['workshop', 'meetup', 'class', 'concert', 'conference', 'sports', 'exhibition', 'festival', 'other']).nullable(),
  placeName: z.string().nullable().describe('Name of the venue or place'),
  location: z.string().nullable().describe('Full address or area/city'),
  locationLink: z.string().nullable().describe('Google Maps or any location URL if mentioned'),
  contactNo: z.string().nullable().describe('Phone number or WhatsApp number for inquiries'),
  paymentType: z.enum(['paid', 'free', 'contribution']).nullable(),
  paymentAmount: z.string().nullable().describe('Amount with currency, e.g. "₹500", "Rs. 200"'),
  startTime: z.string().nullable().describe('Start time in HH:mm (24h) format'),
  endTime: z.string().nullable().describe('End time in HH:mm (24h) format, if mentioned'),
  date: z.string().nullable().describe('Event date in YYYY-MM-DD format'),
  registrationLink: z.string().nullable().describe('Registration or booking URL if mentioned'),
});

export type EventInfo = z.infer<typeof outputSchema>;

const SYSTEM_PROMPT = `You extract event information from WhatsApp group messages. These groups are dedicated to sharing events, so most messages will be event posts.

Set isEvent to false only for non-event messages like:
- Questions, discussions, or replies between members
- Thank you messages, greetings, or general chatter
- Feedback or reviews about past events

EXTRACTION RULES:
- When isEvent is false, set all other fields to null.
- title: Extract exactly as written in the message. Do not rephrase.
- description: Preserve the original wording as-is. Do not summarize or rewrite.
- date: YYYY-MM-DD format. Convert relative dates ("this Saturday", "tomorrow") using today's date. If no date is mentioned, use today's date.
- time: 24-hour HH:mm format. "morning" = 09:00, "evening" = 18:00.
- paymentType: "free" if explicitly free, "paid" if an amount is given, "contribution" if voluntary/donation-based. null if not mentioned.
- locationLink/registrationLink: Only extract if actual URLs are present.
- contactNo: Extract phone numbers mentioned for contact/registration.`;

function buildUserPrompt(message: string): string {
  const today = new Date().toISOString().split('T')[0];
  return `Today's date: ${today}\n\nMessage:\n"""\n${message}\n"""`;
}

export async function generateEventInfo(structuredMessage: StructuredMessage): Promise<EventInfo | null> {
  if (!structuredMessage.message) {
    return null;
  }

  const { output } = await generateText({
    model: openai('gpt-5'),
    prompt: buildUserPrompt(structuredMessage.message),
    output: Output.object({
      schema: outputSchema,
    }),
    system: SYSTEM_PROMPT,
  });

  if (!output || !output.isEvent) {
    return null;
  }

  return output;
}
