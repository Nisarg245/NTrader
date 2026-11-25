// Drives the Web Trader in headless Chrome against a running server with a
// fresh journal (demo account 1002 must have no trades yet).
//
//   npm install --no-save --prefix tools playwright-core
//   node tools/ui-check.mjs [http://127.0.0.1:8080/]
//
// Set CHROME to the browser binary if it is not at the default path, and SHOTS
// to a folder to save screenshots along the way.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:8080/";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const check = (ok, what) => {
  console.log(ok ? "ok  " : "FAIL", what);
  if (!ok) process.exitCode = 1;
};
const shot = async (name) => process.env.SHOTS && (await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }));
const rows = () => page.locator("#trades-panel tbody tr:not(.total)");
const money = async (i) => parseFloat((await page.locator(".metrics dd").nth(i).textContent()).replace(/,/g, ""));

// ---- login
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
await page.waitForFunction(() => document.querySelector(".chart-inner canvas"));
await page.waitForTimeout(2500);

// ---- market watch, groups, favourites, depth
check((await page.locator(".watch-row").count()) === 4, "market watch lists 4 symbols");
check(/[+−]?\d+\.\d\d%/.test(await page.locator(".watch-row").first().textContent()), "day change is shown");
await page.click(".groups >> text=Metals");
check((await page.locator(".watch-row").count()) === 1, "Metals group filters to 1 symbol");
await page.click(".groups >> text=All");
await page.click(".star >> nth=2");
await page.click(".groups >> text=Favourites");
check((await page.textContent(".watch-row")).includes("USDJPY"), "starred symbol appears under Favourites");
await page.click(".groups >> text=All");
await page.waitForSelector(".depth .bids li");
check((await page.locator(".depth li").count()) === 10, "depth of market shows 5 bids and 5 asks");

// ---- market order with stops, from the ticket
const bid = parseFloat(await page.textContent(".chart-price"));
check(bid > 1 && bid < 1.2, "chart header shows a EURUSD price: " + bid);
await page.fill("#ticket-sl", (bid - 0.004).toFixed(5));
await page.fill("#ticket-tp", (bid + 0.006).toFixed(5));
await page.waitForTimeout(200);
check((await page.textContent(".ticket .hint.num.down")).includes("pips"), "stop loss shows distance and money");
await page.click(".ticket .btn-trade.buy");
await rows().first().waitFor();
check((await rows().count()) === 1, "buy opens a position row");
check((await money(2)) > 100, "margin in the header updates");

// ---- trailing stop through Modify
await page.click("#trades-panel >> text=Modify");
await page.fill("#modify-tp", (bid + 0.008).toFixed(5));
await page.fill("#modify-trail", "30");
await shot("modify");
await page.click("dialog[open] >> text=Save");
await page.waitForFunction(() => document.querySelector("#trades-panel tbody tr")?.textContent.includes("trailing"));
check((await rows().first().textContent()).includes((bid + 0.008).toFixed(5)), "modify sets take profit and a trailing stop");

// ---- risk sizing and a rejection
await page.click("text=Calculate lots");
check(parseFloat(await page.inputValue("#ticket-volume")) > 0.1, "size by risk changes the volume");
await page.fill("#ticket-sl", "");
await page.fill("#ticket-tp", "");
await page.fill("#ticket-volume", "100");
await page.click(".ticket .btn-trade.sell");
await page.waitForSelector(".toast.error");
check((await page.textContent(".toast.error")).includes("free margin"), "oversized order shows a rejection message");
await page.fill("#ticket-volume", "0.10");

// ---- confirmation when one-click trading is off, with a limit order
await page.click(".switch");
await page.click(".segmented >> text=Limit");
await page.fill("#ticket-price", (bid - 0.01).toFixed(5));
await page.click(".ticket .btn-trade.buy");
await page.waitForSelector("dialog[open] >> text=Send this order?");
check((await page.textContent("dialog[open]")).includes("limit"), "with one-click off, the order asks for confirmation");
await page.click("dialog[open] >> text=Send order");
await page.click("#tab-orders");
await rows().first().waitFor();
check((await page.textContent("#tab-orders")).includes("1"), "limit order appears under pending orders");
await page.click(".switch");
await page.click(".segmented >> text=Market");

// ---- price alerts: one just above and one just below, so the market reaches one quickly
const setAlert = async (delta) => {
  await page.click("text=Set alert");
  const now = parseFloat(await page.textContent(".chart-price"));
  await page.fill("#alert-price", (now + delta).toFixed(5));
  await page.fill("#alert-note", "test alert");
  await page.click("dialog[open] >> text=Create alert");
  // If the price moved onto the alert price meanwhile, the dialog refuses it; skip that one.
  if (await page.locator("dialog[open]").count()) await page.click("dialog[open] >> text=Cancel");
};
await setAlert(0.00003);
await setAlert(-0.00003);
await page.click("#tab-alerts");
await rows().first().waitFor();
check((await rows().first().textContent()).includes("test alert"), "alert is listed");
await page.waitForFunction(() => document.querySelector("#trades-panel tbody")?.textContent.includes("Reached"), null, { timeout: 90000 });
check(true, "alert fires when the price is reached");

// ---- chart: types, indicators, timeframe, drawings, tabs, split view
await page.click(".chart-tools >> text=Area");
await page.click(".chart-tools >> text=Line");
await page.click(".chart-tools >> text=Candles");
await page.click("text=/Indicators/");
await page.click(".menu-list >> text=RSI");
await page.click(".menu-list >> text=Bollinger");
await page.keyboard.press("Escape");
check((await page.textContent(".menu button")).includes("4"), "indicators can be switched on");
await page.click(".chart-tools >> text=H1");
await page.waitForTimeout(800);
await page.click('[aria-label^="Horizontal line"]');
const box = await page.locator(".chart-inner").boundingBox();
await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.3);
await page.click('[aria-label^="Trend line"]');
await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.25);
await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.15);
await page.click('[aria-label^="Fibonacci"]');
await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.1);
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.35);
await page.waitForTimeout(300);
check((await page.locator(".overlay g").count()) === 3, "three drawings are on the chart");
await shot("chart");
await page.click('[aria-label^="Eraser"]');
await page.locator(".overlay g .hit").first().click({ force: true });
check((await page.locator(".overlay g").count()) === 2, "the eraser removes a drawing");
await page.click('[aria-label^="Pointer"]');

await page.click(".watch-row >> text=XAUUSD");
check((await page.textContent(".chart-head h2")) === "XAUUSD", "selecting a symbol switches the chart");
await page.click('[aria-label="Open another chart"]');
await page.click(".watch-row >> text=GBPUSD");
check((await page.locator(".toolbar .chart-tab").count()) === 2, "a second chart tab opens");
await page.click('[aria-label="Two charts side by side"]');
await page.waitForTimeout(1200);
check((await page.locator(".charts .chart").count()) === 2, "split view shows two charts");
await shot("split");
await page.click('[aria-label="Two charts side by side"]');

// ---- theme, colours, deposit
await page.click('[aria-label="Switch to light theme"]');
await page.waitForTimeout(600);
check((await page.evaluate(() => document.documentElement.dataset.theme)) === "light", "light theme applies");
await shot("light");
await page.click('[aria-label="Settings"]');
await page.click("dialog[open] >> text=Green and red");
await page.click("dialog[open] >> text=Dark");
await page.click("dialog[open] >> text=Done");
check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--up").trim())) === "#3ddc97", "green and red colours apply");
const before = await money(0);
await page.click("text=Deposit");
await page.fill("#deposit-amount", "500");
await page.click("dialog[open] >> text=Add funds");
await page.waitForFunction((b) => parseFloat(document.querySelector(".metrics dd").textContent.replace(/,/g, "")) > b + 400, before);
check(true, "demo top-up raises the balance");

// ---- exposure, news, calendar, journal
await page.click("#tab-exposure");
check((await rows().first().textContent()).includes("Long"), "exposure shows the net position");
await page.click("#tab-news");
check((await page.textContent("#trades-panel")).includes("Welcome"), "broker news is shown");
check((await page.textContent(".calendar")).includes("Sample event"), "calendar shows published events");
await page.click("#tab-journal");
check((await rows().count()) >= 5, "journal records the session");

// ---- keyboard shortcut, close losing/profitable, history
await page.click(".chart-head h2");
await page.keyboard.press("b");
await page.click("#tab-positions");
await page.waitForFunction(() => document.querySelectorAll("#trades-panel tbody tr:not(.total)").length === 2);
check(true, "pressing B buys at market");
await page.click("text=Close all");
await page.click("dialog[open] >> text=/^Close 2$/");
await page.waitForSelector("#trades-panel .empty");
await page.click("#tab-history");
check((await rows().count()) === 4, "history lists every open and close");
await page.click("#tab-orders");
await page.click("#trades-panel >> text=Cancel");
await page.waitForSelector("#trades-panel .empty");
check(true, "pending order cancels");
await shot("end");

// ---- phone width
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 0, "no horizontal overflow at phone width (" + overflow + "px)");
await shot("phone");
check(errors.length === 0, "no console errors " + JSON.stringify(errors.slice(0, 3)));
await browser.close();
