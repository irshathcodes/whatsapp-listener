import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, Output } from 'ai';
import z from 'zod';
import { type StructuredMessage } from './message-utils.js';

const nim = createOpenAICompatible({
  name: 'nim',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  headers: {
    Authorization: `Bearer ${process.env.NIM_API_KEY}`,
  },
});

const outputSchema = z.object({
  title: z.string(),
  description: z.string(),
  category: z.enum(['workshop', 'event', 'class']),
  placeName: z.string(),
  location: z.string().nullable(),
  locationLink: z.url().nullable(),
  contactNo: z.string().nullable(),
  paymentType: z.enum(['contribution', 'free']).nullable(),
  paymentAmount: z.string().nullable(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  date: z.string()
})

export async function generateEventInfo(structuredMessage: StructuredMessage): Promise<z.infer<typeof outputSchema>> {

  const { output } = await generateText({
    model: nim.chatModel('moonshotai/kimi-k2-instruct'),
    // update prompt here
    prompt: ``,
    output: Output.object({
      schema: outputSchema
    }),

    // update system prompt here
    system: '',
  });

  return output;
}



