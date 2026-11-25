// Drives the admin panel in headless Chrome against a running server.
//
//   npm install --no-save --prefix tools playwright-core
//   node tools/admin-check.mjs [http://127.0.0.1:8080]
//
// Set CHROME to the browser binary if it is not at the default path, and SHOTS
// to a folder to save screenshots along the way.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:8080";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
// Refusals this test provokes on purpose (wrong password, short password, overdraft)
// answer 400 or 401, which the browser logs as failed resources. Those are expected.
page.on("console", (m) => m.type() === "error" && !/status of 40[01]/.test(m.text()) && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const check = (ok, what) => {
  console.log(ok ? "ok  " : "FAIL", what);
  if (!ok) process.exitCode = 1;
};
const shot = async (name) => process.env.SHOTS && (await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }));
const rows = () => page.locator("main table tbody tr");
const nav = (name) => page.click(`.admin-nav .tab >> text="${name}"`);
const unique = Date.now().toString().slice(-6);

// A trader with an open position, so the manager has something to see and close.
await new Promise((resolve, reject) => {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  ws.onopen = () => ws.send(JSON.stringify({ type: "Login", account: 1001, password: "demo1001" }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "LoginOk") ws.send(JSON.stringify({ type: "Order", symbol: "GBPUSD", side: "Sell", kind: "Market", volume: 2000 }));
    if (m.type === "Event" && m.event.type === "Deal") (ws.close(), resolve());
    if (m.type === "Error" || (m.type === "Event" && m.event.type === "Rejected")) reject(new Error(JSON.stringify(m)));
  };
});

// ---- login
await page.goto(base + "/admin");
await page.fill("#m-login", "admin");
await page.fill("#m-password", "not-the-password");
await page.click("button[type=submit]");
await page.waitForSelector(".login .error");
check((await page.textContent(".login .error")).includes("wrong login"), "wrong manager password shows an error");
await page.fill("#m-password", "admin-demo-1");
await page.click("button[type=submit]");
await page.waitForSelector(".tiles");

// ---- dashboard
await page.waitForFunction(() => document.querySelector(".tile dd")?.textContent !== "—");
check(Number(await page.locator(".tile dd").first().textContent()) >= 2, "dashboard counts the accounts");
check((await page.textContent("#exposure-title ~ .table-box")).includes("Long 0.20"), "dashboard shows the broker long 0.20 GBPUSD against the client's short");
await shot("admin-dashboard");

// ---- positions: the manager sees and closes the trader's position
await nav("Positions");
await rows().first().waitFor();
const before = await rows().count();
check((await page.textContent("main table")).includes("GBPUSD"), "positions list shows the client's GBPUSD position");
await page.click('main table >> text="Close" >> nth=0');
await page.waitForFunction((n) => document.querySelectorAll("main table tbody tr").length < n || document.querySelector("main .empty"), before);
check(true, "manager closes a position");

// ---- groups
await nav("Groups");
await rows().first().waitFor();
await page.click('text="New group"');
await page.fill("#g-name", `ui-${unique}`);
await page.fill("#g-lev", "300");
await page.fill("#g-comm", "2.50");
await page.click('dialog[open] >> text="Save group"');
await page.waitForFunction((n) => document.querySelector("main table")?.textContent.includes(n), `ui-${unique}`);
check((await page.textContent("main table")).includes("1:300"), "a new group is created");
await page.click(`[aria-label="Edit group ui-${unique}"]`);
await page.fill("#g-so", "30");
await page.click('dialog[open] >> text="Save group"');
await page.waitForFunction(() => document.querySelector("main table")?.textContent.includes("30%"));
check(true, "a group's stop-out level is edited");

// ---- symbols
await nav("Symbols");
await rows().first().waitFor();
await page.click('[aria-label="Edit symbol XAUUSD"]');
await page.fill("#s-swl", "-12");
await page.click('dialog[open] >> text="Save symbol"');
await page.waitForFunction(() => document.querySelector("main table")?.textContent.includes("-12 /"));
check(true, "a symbol's swap is edited");
await page.click('text="New symbol"');
await page.fill("#s-name", `T${unique}`);
await page.fill("#s-base", "AUD");
await page.fill("#s-digits", "9");
await page.click('dialog[open] >> text="Save symbol"');
await page.waitForFunction((n) => document.querySelector("main table")?.textContent.includes(n), `T${unique}`);
check(true, "a new symbol is created");
await shot("admin-symbols");

// ---- accounts: create, fund, edit, disable
await nav("Accounts");
await rows().first().waitFor();
await page.click('text="New account"');
await page.selectOption("#a-group", `ui-${unique}`);
await page.fill("#a-name", `Trader ${unique}`);
await page.fill("#a-password", "short");
await page.fill("#a-deposit", "2500");
await page.evaluate(() => document.querySelector("#a-password").removeAttribute("minlength"));
await page.click('dialog[open] >> text="Create account"');
await page.waitForSelector("dialog[open] [role=alert]");
check((await page.textContent("dialog[open] [role=alert]")).includes("8 characters"), "a short password is refused with a reason");
await page.fill("#a-password", "long-enough-pass");
await page.click('dialog[open] >> text="Create account"');
await page.waitForFunction((n) => document.querySelector("main table")?.textContent.includes(n), `Trader ${unique}`);
check((await page.textContent("main")).includes("2,500.00"), "a new account is created with its opening deposit");

await page.fill("#acc-search", `Trader ${unique}`);
await page.waitForFunction(() => document.querySelectorAll("main table tbody tr").length === 1);
check(true, "search narrows the list to the account");
await page.click('main table >> text="Open"');
await page.waitForSelector("dialog[open] #d-amount");
await page.fill("#d-amount", "500");
await page.fill("#d-comment", "bonus");
await page.click('dialog[open] >> text="Deposit"');
await page.waitForFunction(() => document.querySelector("dialog[open] .summary")?.textContent.includes("3,000.00"));
check(true, "a deposit is booked from the account window");
await page.fill("#d-amount", "99999");
await page.click('dialog[open] >> text="Withdraw"');
await page.waitForSelector("dialog[open] [role=alert]");
check((await page.textContent("dialog[open] [role=alert]")).includes("free balance"), "overdrawing is refused with a reason");
await page.fill("#d-lev", "25");
await page.click('dialog[open] >> text="Save"');
await page.click('dialog[open] >> text="Disable account"');
await page.waitForFunction(() => document.querySelector("#account-title")?.textContent.includes("Disabled"));
await shot("admin-account");
await page.click('dialog[open] >> text="Done"');
await page.waitForFunction(() => document.querySelector("main table")?.textContent.includes("Disabled"));
check((await page.textContent("main table")).includes("1:25"), "leverage change and disabling show in the list");

// ---- log out
await page.click('text="Log out"');
await page.waitForSelector("#m-login");
check(true, "log out returns to the sign-in page");
check(errors.length === 0, "no console errors " + JSON.stringify(errors.slice(0, 3)));
await browser.close();
