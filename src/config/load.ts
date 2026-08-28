import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseConfig, type Agent2APIConfig } from "./schema.js";

export async function loadConfig(configPath?: string): Promise<Agent2APIConfig> {
  if (!configPath) return parseConfig({}, process.cwd());
  const absolutePath = path.resolve(configPath);
  const source = await readFile(absolutePath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${absolutePath}`, { cause: error });
  }
  return parseConfig(value, path.dirname(absolutePath));
}
