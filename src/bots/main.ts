import { loadBotsConfigFile, runBots } from './index.ts';

const config = loadBotsConfigFile(process.env.BOTS_CONFIG_FILE || '/run/config/bots.json');
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
await runBots({ config, signal: controller.signal });
