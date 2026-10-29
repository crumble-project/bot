import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg" with { type: "text" };
import azureai from "@lobehub/icons-static-svg/icons/azureai-color.svg" with { type: "text" };
import baseten from "@lobehub/icons-static-svg/icons/baseten.svg" with { type: "text" };
import bedrock from "@lobehub/icons-static-svg/icons/bedrock-color.svg" with { type: "text" };
import cerebras from "@lobehub/icons-static-svg/icons/cerebras-color.svg" with { type: "text" };
import claudecode from "@lobehub/icons-static-svg/icons/claudecode-color.svg" with { type: "text" };
import cloudflare from "@lobehub/icons-static-svg/icons/cloudflare-color.svg" with { type: "text" };
import codex from "@lobehub/icons-static-svg/icons/codex-color.svg" with { type: "text" };
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg" with { type: "text" };
import fireworks from "@lobehub/icons-static-svg/icons/fireworks-color.svg" with { type: "text" };
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg" with { type: "text" };
import githubcopilot from "@lobehub/icons-static-svg/icons/githubcopilot.svg" with { type: "text" };
import groq from "@lobehub/icons-static-svg/icons/groq.svg" with { type: "text" };
import huggingface from "@lobehub/icons-static-svg/icons/huggingface-color.svg" with { type: "text" };
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg" with { type: "text" };
import ling from "@lobehub/icons-static-svg/icons/ling-color.svg" with { type: "text" };
import meta from "@lobehub/icons-static-svg/icons/meta-color.svg" with { type: "text" };
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg" with { type: "text" };
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg" with { type: "text" };
import moonshot from "@lobehub/icons-static-svg/icons/moonshot.svg" with { type: "text" };
import nvidia from "@lobehub/icons-static-svg/icons/nvidia-color.svg" with { type: "text" };
import openai from "@lobehub/icons-static-svg/icons/openai.svg" with { type: "text" };
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg" with { type: "text" };
import openrouter from "@lobehub/icons-static-svg/icons/openrouter-color.svg" with { type: "text" };
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg" with { type: "text" };
import together from "@lobehub/icons-static-svg/icons/together-color.svg" with { type: "text" };
import vercel from "@lobehub/icons-static-svg/icons/vercel.svg" with { type: "text" };
import vertexai from "@lobehub/icons-static-svg/icons/vertexai-color.svg" with { type: "text" };
import workersai from "@lobehub/icons-static-svg/icons/workersai-color.svg" with { type: "text" };
import xai from "@lobehub/icons-static-svg/icons/xai.svg" with { type: "text" };
import xiaomimimo from "@lobehub/icons-static-svg/icons/xiaomimimo.svg" with { type: "text" };
import zai from "@lobehub/icons-static-svg/icons/zai.svg" with { type: "text" };

/** Each provider's logo as SVG markup from LobeHub Icons; providers it lacks, such as Radius, keep a letter tile. */
const LOGOS = {
  "amazon-bedrock": bedrock,
  "ant-ling": ling,
  anthropic: anthropic,
  azure: azureai,
  baseten: baseten,
  cerebras: cerebras,
  "claude-code": claudecode,
  "cloudflare-ai-gateway": cloudflare,
  "cloudflare-workers-ai": workersai,
  deepseek: deepseek,
  fireworks: fireworks,
  "github-copilot": githubcopilot,
  google: gemini,
  "google-vertex": vertexai,
  groq: groq,
  huggingface: huggingface,
  "kimi-coding": kimi,
  meta: meta,
  minimax: minimax,
  "minimax-cn": minimax,
  mistral: mistral,
  moonshotai: moonshot,
  "moonshotai-cn": moonshot,
  nvidia: nvidia,
  openai: openai,
  "openai-codex": codex,
  opencode: opencode,
  "opencode-go": opencode,
  openrouter: openrouter,
  "qwen-token-plan": qwen,
  "qwen-token-plan-cn": qwen,
  "qwen-token-plan-individual": qwen,
  together: together,
  "vercel-ai-gateway": vercel,
  xai: xai,
  xiaomi: xiaomimimo,
  "xiaomi-token-plan-ams": xiaomimimo,
  "xiaomi-token-plan-cn": xiaomimimo,
  "xiaomi-token-plan-sgp": xiaomimimo,
  zai: zai,
  "zai-coding-cn": zai,
} satisfies Record<string, string>;

const byProvider = new Map<string, string>(Object.entries(LOGOS));

export const providerLogo = (providerId: string) => byProvider.get(providerId);
