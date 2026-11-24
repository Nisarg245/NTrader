// Drives the Web Trader in headless Chrome against a running server with a
// fresh journal (demo account 1002 must have no trades yet).
//
//   npm install --no-save playwright-core
//   node tools/ui-check.mjs [http://127.0.0.1:8080/]
//
// Set CHROME to the browser binary if it is not at the default path.
import { chromium } from "playwright-core";
const base = process.argv[2] ?? "http://127.0.0.1:8080/";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) process.exitCode = 1; };

await page.goto(base);
await page.fill("#login-account", "1001");
await page.fill("#login-password", "nope");
await page.click("button[type=submit]");
await page.waitForSelector(".login .error");
check((await page.textContent(".login .error")).includes("Wrong account"), "wrong password shows an error");

// Account 1002 is left untouched by tools/smoke.mjs, so its history starts empty.
await page.fill("#login-account", "1002");
await page.fill("#login-password", "demo1002");
await page.click("button[type=submit]");
await page.waitForSelector(".watch-row");
check((await page.locator(".watch-row").count()) === 4, "market watch lists 4 symbols");
await page.waitForFunction(() => document.querySelector(".chart-inner canvas"));
await page.waitForTimeout(2500);
const bid1 = await page.textContent(".chart-price");
await page.waitForTimeout(2500);
const allBids = await page.locator(".watch-row").allTextContents();
check(/^\d\.\d{5}$/.test(bid1.trim()), "chart header shows a EURUSD price: " + bid1);

// Market buy 0.10 with SL/TP typed relative to the current price.
const bid = parseFloat(bid1);
await page.fill("#ticket-sl", (bid - 0.004).toFixed(5));
await page.fill("#ticket-tp", (bid + 0.006).toFixed(5));
await page.waitForTimeout(200);
check((await page.textContent(".ticket .hint.num.down")).includes("pips"), "stop loss shows distance and money");
await page.click(".btn-trade.buy");
await page.waitForSelector("#trades-panel tbody tr:not(.total)");
check((await page.locator("#trades-panel tbody tr:not(.total)").count()) === 1, "buy opens a position row");
const margin = await page.locator(".metrics dd").nth(2).textContent();
check(parseFloat(margin.replace(",", "")) > 100, "margin in header updates: " + margin);

// Risk sizing then an oversized order that must be rejected.
await page.click("text=Calculate lots");
const sized = await page.inputValue("#ticket-volume");
check(parseFloat(sized) > 0.1, "size by risk changes volume to " + sized);
await page.fill("#ticket-sl", ""); await page.fill("#ticket-tp", "");
await page.fill("#ticket-volume", "100");
await page.click(".btn-trade.sell");
await page.waitForSelector(".toast.error");
check((await page.textContent(".toast.error")).includes("free margin"), "oversized order shows a rejection message");
await page.fill("#ticket-volume", "0.10");

// Pending order.
await page.click(".segmented >> text=Limit");
await page.fill("#ticket-sl", ""); await page.fill("#ticket-tp", "");
await page.fill("#ticket-price", (bid - 0.01).toFixed(5));
await page.click(".btn-trade.buy");
await page.click("#tab-orders");
await page.waitForSelector("#trades-panel tbody tr");
check((await page.textContent("#tab-orders")).includes("1"), "limit order appears under pending orders");
await page.click("#tab-positions");
await page.waitForTimeout(1500);

// Modify, then switch symbol and timeframe.
await page.click("#trades-panel >> text=Modify");
await page.fill("#modify-tp", (bid + 0.008).toFixed(5));
await page.click("dialog[open] >> text=Save");
await page.waitForTimeout(500);
check((await page.textContent("#trades-panel tbody tr >> nth=0")).includes((bid + 0.008).toFixed(5)), "modify updates take profit");
await page.click(".watch-row >> text=XAUUSD");
await page.click(".chart-tools >> text=H1");
await page.waitForTimeout(1500);
check((await page.textContent("#chart-title")) === "XAUUSD", "selecting a symbol switches the chart");

// History and close.
await page.click("#tab-positions");
await page.click("#trades-panel >> text=Close >> nth=0");
await page.waitForSelector("#trades-panel .empty");
await page.click("#tab-history");
check((await page.locator("#trades-panel tbody tr").count()) === 2, "history lists the open and close deals");
await page.click("#tab-orders");
await page.click("#trades-panel >> text=Cancel");
await page.waitForSelector("#trades-panel .empty");
check(true, "pending order cancels");

// Phone width.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 0, "no horizontal overflow at phone width (" + overflow + "px)");
check(errors.length === 0, "no console errors " + JSON.stringify(errors.slice(0, 3)));
await browser.close();
