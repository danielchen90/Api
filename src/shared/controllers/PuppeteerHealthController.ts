import { controller, httpGet } from "inversify-express-utils";
import express from "express";
import { execSync } from "child_process";

/**
 * TEMPORARY Phase-0 spike endpoint — proves headless Chromium launches inside the
 * deployed Railway container before the Phase 6 render pipeline is built.
 *
 * Gated behind PUPPETEER_SMOKE=true so it is unmistakably temporary; remove when
 * Phase 6 ships the real license renderer. Uses the SYSTEM chromium (installed via
 * nixpacks.toml) because .yarnrc.yml sets enableScripts:false, so puppeteer's bundled
 * Chromium is never downloaded during the container build.
 */
@controller("/health")
export class PuppeteerHealthController {
  @httpGet("/puppeteer")
  public async puppeteerSmoke(_req: express.Request, res: express.Response): Promise<any> {
    if (process.env.PUPPETEER_SMOKE !== "true") {
      return res.status(404).json({ ok: false, error: "puppeteer smoke endpoint disabled (set PUPPETEER_SMOKE=true)" });
    }

    let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || "";
    if (!executablePath) {
      try {
        executablePath = execSync("which chromium || which chromium-browser || which google-chrome-stable || which google-chrome")
          .toString()
          .trim();
      } catch {
        executablePath = "";
      }
    }

    try {
      const puppeteer = (await import("puppeteer")).default;
      const browser = await puppeteer.launch({
        headless: true,
        executablePath: executablePath || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      });
      const page = await browser.newPage();
      await page.setContent("<h1>ok</h1>");
      const pdf = await page.pdf();
      const chromiumVersion = await browser.version();
      await browser.close();
      return res.json({
        ok: true,
        chromiumVersion,
        pdfBytes: pdf.length,
        executablePath: executablePath || "(puppeteer bundled)"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, error: message, executablePath: executablePath || null });
    }
  }
}
