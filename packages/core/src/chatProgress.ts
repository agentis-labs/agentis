/** A deterministic first status, available before any model runtime responds. */
export function initialTurnActivityLabel(message: string): string {
  const text = message.replace(/^\/(?:ask|plan|auto)\b/i, '').trim().toLowerCase();
  if (/^(?:hi|hello|hey|thanks|thank you|ol[aá]|oi|obrigad[oa])\b[!.?\s]*$/i.test(text)) return 'Request received';
  if (/\b(?:interface|ui|ux|screen|layout|frontend|front-end)\b/i.test(text)) return 'Starting the interface check';
  if (/\bworkspace\b/i.test(text) && /\b(?:health|check|review|audit|inspect)\b/i.test(text)) return 'Starting the workspace check';
  if (/\b(?:error|failed|failure|bug|broken|fix|repair|debug|diagnos)\w*\b/i.test(text)) return 'Starting the diagnosis';
  if (/\b(?:workflow|automation)\b/i.test(text)) return 'Starting the workflow check';
  if (/\b(?:document|file|attachment|pdf|spreadsheet)\b/i.test(text)) return 'Starting the file review';
  if (/\b(?:search|research|find|look up|lookup)\b/i.test(text)) return 'Starting the search';
  if (/\b(?:build|create|implement|make|develop)\b/i.test(text)) return 'Starting the build';
  if (/\b(?:app|application)\b/i.test(text)) return 'Starting the app check';
  return 'Starting the first step';
}
