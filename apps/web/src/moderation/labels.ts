import type { ReportCategory } from '@tessera/validation';

/** Report reasons, in the order people are asked (most common first). */
export const CATEGORY_LABELS: readonly { value: ReportCategory; label: string }[] = [
  { value: 'spam', label: 'Spam or unwanted messages' },
  { value: 'scam', label: 'Scam or fraud' },
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'hate', label: 'Hate speech' },
  { value: 'violence_threat', label: 'Threats of violence' },
  { value: 'self_harm', label: 'Self-harm or suicide' },
  { value: 'sexual_content', label: 'Unwanted sexual content' },
  { value: 'ncii', label: 'Intimate images shared without consent' },
  { value: 'synthetic_media', label: 'Fake (deepfake) images or video of someone' },
  { value: 'csam', label: 'Sexual content involving a child' },
  { value: 'terrorism', label: 'Terrorism or violent extremism' },
  { value: 'impersonation', label: 'Pretending to be someone else' },
  { value: 'other', label: 'Something else' },
];

export function categoryLabel(value: string): string {
  return CATEGORY_LABELS.find((c) => c.value === value)?.label ?? value;
}

export const ACTION_LABELS: Record<string, string> = {
  warn: 'Warning',
  restrict: 'Limited features',
  suspend: 'Suspension',
  ban: 'Ban',
  remove_content: 'Content removed',
  channel_unlist: 'Channel removed from the directory',
  channel_suspend: 'Channel suspended',
  legal_referral: 'Referred to the legal team',
};
