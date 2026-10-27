import { loadEnv } from './env.js';

const env = loadEnv(process.env);
console.log(`Configured to listen on port ${env.PORT}`);
