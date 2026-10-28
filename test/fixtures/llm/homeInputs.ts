// The inputs the home LLM fixtures were authored from (see author.ts); tests rebuild the same prompts from them.
export const HOME_RANK_CATEGORY = { name: 'Emergency electrician', hoursNeed: 'overnight' as const, area: 'home' as const };
export const HOME_DRAFT_TITLE = 'Gas smell or CO alarm';
export const HOME_DRAFT_SOURCES = ['https://gas-safety.example/gas-leak'];
export const HOME_EXTRACT_URL = 'https://rapid-rooter.example/';
