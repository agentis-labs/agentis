export const FALLBACK_PLACEHOLDER_PHRASES = [
  'Build a workflow that posts to LinkedIn every Monday...',
  'Create an agent for customer support research...',
  'Set up a routine that emails the weekly digest...',
  'Activate the Q2 marketing app in this workspace...',
  'Research competitors in the CRM space...',
  'Ask an agent to build a landing page for this idea...',
  'Schedule the newsletter workflow for every Friday at 9am...',
  'Draft a content workflow for the next campaign...',
  'Which agents are online right now...',
];

export function workspacePlaceholderPhrases(ctx: {
  agents: Array<{ name: string }>;
  teams: Array<{ name: string }>;
  workflows: Array<{ title: string }>;
}): string[] {
  const phrases: string[] = [];
  const firstAgent = ctx.agents[0]?.name;
  const secondAgent = ctx.agents[1]?.name;
  const firstTeam = ctx.teams[0]?.name;
  const secondTeam = ctx.teams[1]?.name;
  const firstWorkflow = ctx.workflows[0]?.title;

  if (firstAgent) phrases.push(`Ask @${firstAgent} to write the weekly newsletter...`);
  if (secondAgent) phrases.push(`Check if @${secondAgent} has finished the Q2 research...`);
  if (firstWorkflow) phrases.push(`Run the ${firstWorkflow} workflow again...`);
  if (firstTeam) phrases.push(`Send an update request to the ${firstTeam} team...`);
  if (firstAgent) phrases.push(`Show me what ${firstAgent} built today...`);
  if (secondTeam) phrases.push(`What's the ${secondTeam} team working on right now...`);
  if (ctx.agents.length > 1) phrases.push('Ask all agents for a status update...');

  return phrases;
}