/** How long ago an ISO time was, in the glass's short form: 40s, 12m, 3.5h, 2d. Empty without a time. */
export const ageText = (iso: string | undefined | null): string => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return Math.round(s) + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  if (s < 172800) return (s / 3600).toFixed(1) + 'h';
  return Math.round(s / 86400) + 'd';
};
