import { z } from 'zod';

export const BuyerContactCandidateSchema = z.object({
  company: z.string().min(1),
  personName: z.string().min(1),
  currentCompany: z.string().min(1),
  currentTitle: z.string().min(1),
  region: z.string().min(1),
  linkedinUrl: z.string(),
  publicProfileUrls: z.array(z.string()).min(1),
  roleCategory: z.enum([
    'direct-buyer',
    'purchasing-leader',
    'supplier-development',
    'project-purchasing',
    'engineering-routing'
  ]),
  relevantApplication: z.string().min(1),
  recommendedScore: z.number().int().min(0).max(100),
  whyRelevant: z.string().min(1),
  firstQuestion: z.string().min(1),
  verificationLevel: z.enum(['public-confirmed', 'strong-candidate']),
  confidence: z.enum(['high', 'medium']),
  evidenceSummary: z.string().min(1)
});

export const BuyerAgentOutputSchema = z.object({
  generatedAt: z.string(),
  contacts: z.array(BuyerContactCandidateSchema).max(20),
  notes: z.array(z.string())
});

export type BuyerContactCandidate = z.infer<typeof BuyerContactCandidateSchema>;
export type BuyerAgentOutput = z.infer<typeof BuyerAgentOutputSchema>;
