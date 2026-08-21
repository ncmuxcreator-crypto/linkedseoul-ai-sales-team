import { z } from 'zod';

export const MarketCandidateSchema = z.object({
  company: z.string().min(1),
  country: z.string().default(''),
  estimatedMakerOems: z.array(z.string()).default([]),
  makerEvidenceNote: z.string().default(''),
  application: z.string().min(1),
  signalType: z.enum([
    'purchasing',
    'supplier-entry',
    'hiring',
    'plant',
    'program',
    'technology',
    'organization',
    'other'
  ]),
  signalSummary: z.string().min(1),
  // Keep source URLs as strings in the structured-output schema because the
  // Responses API JSON-schema subset does not accept Zod's `format: uri`.
  // URL shape is treated as evidence text and can be validated downstream.
  sourceUrls: z.array(z.string().min(1)).min(1),
  applicationFit: z.number().int().min(0).max(30),
  externalSourcingProbability: z.number().int().min(0).max(25),
  timing: z.number().int().min(0).max(20),
  buyerAccessibility: z.number().int().min(0).max(15),
  evidenceQuality: z.number().int().min(0).max(10),
  verticalIntegrationPenalty: z.number().int().min(0).max(25),
  score: z.number().int().min(0).max(100),
  whyNow: z.string().min(1),
  recommendedBuyerFunctions: z.array(z.string()).default([]),
  recommendedAction: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  makeBuyNote: z.string().default('')
});

export const MarketAgentOutputSchema = z.object({
  generatedAt: z.string(),
  candidates: z.array(MarketCandidateSchema).max(20),
  notes: z.array(z.string()).default([])
});

export type MarketCandidate = z.infer<typeof MarketCandidateSchema>;
export type MarketAgentOutput = z.infer<typeof MarketAgentOutputSchema>;
