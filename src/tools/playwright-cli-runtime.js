import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { READ_RESULTS_SCRIPT } from "./browser-page-runtime.js";

const execFileAsync = promisify(execFile);
export const PLAYWRIGHT_SESSION = "ypscan";

function defaultWrapperPath() {
  const root =
    process.env.YPACTION_SKILLS_ROOT ||
    process.env.SKILLS_ROOT ||
    join(homedir(), "Library", "Application Support", "YP Action", "SKILLs");
  return join(root, "playwright", "scripts", "playwright_cli.sh");
}

function detailScript(platform) {
  return `async page => page.evaluate((platform) => {
    const clean = value => String(value ?? '').replace(/\\s+/gu, ' ').trim();
    const body = clean(document.body?.innerText);
    const first = patterns => { for (const source of patterns) { const match = body.match(new RegExp(source, 'iu')); if (match?.[1]) return clean(match[1]); } return null; };
    const fields = {
      followers_raw: first(['粉丝(?:数|量)?\\s*[:：]?\\s*([\\d.,]+\\s*[万wWkK亿]?)','([\\d.,]+\\s*[万wWkK亿]?)\\s*粉丝']),
      city: first(['(?:所在地|所在地域|城市|地区)\\s*[:：]?\\s*([^\\s|｜]{2,16})']),
      agency: first(['(?:所属机构|MCN机构|机构)\\s*[:：]?\\s*([^\\n|｜]{2,40})']),
      account_type: first(['(?:账号类型|达人类型)\\s*[:：]?\\s*([^\\n|｜]{2,40})']),
      cpm_raw: first(['(?:预期\\s*)?CPM\\s*[:：¥￥]?\\s*([\\d.]+)']),
      cpe_raw: first(['(?:预期\\s*)?CPE\\s*[:：¥￥]?\\s*([\\d.]+)']),
      interaction_rate_raw: first(['(?:互动率|互动占比)\\s*[:：]?\\s*([\\d.]+\\s*%)']),
      expected_views_raw: first(['(?:预期播放|预期阅读|预估阅读|平均播放)\\s*[:：]?\\s*([\\d.]+\\s*[万wWkK亿]?)']),
      audience_male_rate_raw: first(['(?:男性|男)粉丝(?:占比)?\\s*[:：]?\\s*([\\d.]+\\s*%)']),
      audience_female_rate_raw: first(['(?:女性|女)粉丝(?:占比)?\\s*[:：]?\\s*([\\d.]+\\s*%)'])
    };
    const challengeNode = document.querySelector('#captcha_container,iframe[src*=verifycenter],iframe[src*=captcha],[class*=slide-verify]');
    const challenge = /verifycenter|captcha|challenge/iu.test(location.href) || Boolean(challengeNode?.getClientRects().length);
    const login = /登录|扫码登录/u.test(body) && !/已选条件|找到\\s*\\d+\\s*个?达人/u.test(body);
    return { url: location.href, platform, body_excerpt: body.slice(0, 500), challenge, login, fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) };
  }, ${JSON.stringify(platform)})`;
}

function listScript(platform) {
  return `async page => {
    const data = await page.evaluate(${READ_RESULTS_SCRIPT}, ${JSON.stringify({ platform })});
    const body = await page.locator('body').innerText().catch(() => '');
    const url = page.url();
    const challenge = /verifycenter|captcha|challenge/iu.test(url) || await page.locator('#captcha_container:visible,iframe[src*=verifycenter]:visible,iframe[src*=captcha]:visible,[class*=slide-verify]:visible').count() > 0;
    const login = /登录|扫码登录/u.test(body) && !/已选条件|找到\\s*\\d+\\s*个?达人/u.test(body);
    const current = body.match(/(?:^|\\s)(\\d+)\\s*(?:页|\\/\\s*\\d+\\s*页)/u)?.[1];
    return { ...data, page_number: current ? Number(current) : 1, challenge, login, body_excerpt: body.slice(0, 500) };
  }`;
}

function parseRawJson(stdout) {
  const text = String(stdout ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`Playwright CLI 未返回 JSON：${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

export function createPlaywrightCliRuntime({
  wrapperPath = defaultWrapperPath(),
  session = PLAYWRIGHT_SESSION,
  exec = execFileAsync,
} = {}) {
  if (session.length > 12) throw new Error("Playwright session 名称过长");
  async function evaluate(code) {
    try {
      const { stdout } = await exec(wrapperPath, ["--session", session, "--raw", "run-code", code], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
      });
      return parseRawJson(stdout);
    } catch (error) {
      const wrapped = /** @type {Error & {code?: string}} */ (
        new Error(error?.stderr || error?.message || String(error))
      );
      wrapped.code = "YPSCAN_PLAYWRIGHT_SESSION_UNAVAILABLE";
      throw wrapped;
    }
  }
  return {
    session,
    wrapper_path: wrapperPath,
    readList: (platform) => evaluate(listScript(platform)),
    readDetail: (platform) => evaluate(detailScript(platform)),
  };
}
