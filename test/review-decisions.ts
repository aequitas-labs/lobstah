import type { ReviewDecision } from '../packages/core/src/review-decisions.js';

/** Product calls shared by the draft, posting, and Glass behavior tests. */
export const REVIEW_DECISIONS: ReviewDecision[] = [{
  id: 'rollout-owner',
  question: 'Who should own the rollout?',
  options: [
    { id: 'product', label: 'Product team', consequence: 'Product chooses when the feature goes live.' },
    { id: 'platform', label: 'Platform team', consequence: 'Platform schedules the release with infrastructure changes.' },
  ],
  recommendation: 'product',
}, {
  id: 'existing-users',
  question: 'Should existing users get the new default?',
  options: [
    { id: 'keep', label: 'Keep current settings', consequence: 'Existing users keep the behavior they chose.' },
    { id: 'migrate', label: 'Migrate everyone', consequence: 'All users get the new default on release.' },
  ],
  recommendation: 'keep',
}];
