const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const randomUseragent = require("random-useragent");

puppeteer.use(StealthPlugin());

(async () => {
  // Launch browser with CI optimization flags
  const browser = await puppeteer.launch({
    headless: "new",  // Use new Headless mode
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
      "--max-old-space-size=2048"
    ],
  });

  const page = await browser.newPage();
  
  // Set extended timeouts for CI environment
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(90000);

  await page.setViewport({ width: 1280, height: 1200 });

  const dateStamp = new Date().toISOString().split("T")[0];
  const csvFile = `floor_sheet_data_${dateStamp}.csv`;
  const logger = fs.createWriteStream(csvFile, { flags: "a" });

  if (!fs.existsSync(csvFile) || fs.statSync(csvFile).size === 0) {
    logger.write("SN,ContractNo,Symbol,Buyer,Seller,Quantity,Rate,Amount\n");
  }

  await page.setUserAgent(randomUseragent.getRandom());

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "stylesheet", "font", "media"].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  console.log("🔄 Navigating to NEPSE floor sheet...");
  
  // Navigation with retry logic
  let navigationSuccess = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto("https://nepalstock.com.np/floor-sheet", {
        waitUntil: "domcontentloaded",
        timeout: 90000
      });
      navigationSuccess = true;
      break;
    } catch (err) {
      console.log(`⚠️ Navigation attempt ${attempt} failed: ${err.message}`);
      if (attempt === 3) {
        console.error("❌ All navigation attempts failed");
        await browser.close();
        return;
      }
      await page.waitForTimeout(5000);
    }
  }

  try {
    console.log("🔍 Waiting for filter elements...");
    await page.waitForSelector("div.box__filter--field", { timeout: 60000 });
    
    // Debugging: Capture screenshot
    await page.screenshot({ path: "debug-selector.png" });

    console.log("📊 Setting rows per page to 500...");
    await page.select("div.box__filter--field select", "500");

    const btn = await page.waitForSelector("button.box__filter--search", { timeout: 60000 });
    
    console.log("🔄 Applying filter...");
    await btn.click();
    
    // Wait for table content to load
    console.log("⏳ Waiting for table data...");
    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll("table.table-striped tbody tr");
        return rows.length >= 500 && rows[0].querySelector("td")?.textContent?.trim() !== '';
      },
      { timeout: 120000, polling: 1000 }
    );

    await page.waitForTimeout(1000);

  } catch (e) {
    console.error(`❌ Initialization failed: ${e.message}`);
    await page.screenshot({ path: "init-failure.png" });
    const content = await page.content();
    fs.writeFileSync("page-dump.html", content);
    await browser.close();
    return;
  }

  let currentPage = 1;

  while (true) {
    console.log(`➡️ Scraping page ${currentPage}`);

    try {
      await page.waitForSelector("table.table-striped tbody tr", {
        timeout: 30000,
      });
    } catch (e) {
      console.warn(`⚠️ Timed out waiting for rows: ${e.message}`);
      await page.screenshot({ path: `page-${currentPage}-timeout.png` });
      break;
    }

    const rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("table.table-striped tbody tr"))
        .map((tr) =>
          Array.from(tr.querySelectorAll("td"))
            .map((td) =>
              `"${td.textContent.trim().replace(/"/g, '""').replace(/\.00$/, "")}"`
            )
            .join(",")
        )
        .filter((row) => row.length > 0);
    });

    if (rows.length === 0) {
      console.log("⚠️ No rows found. Ending scraping.");
      break;
    }

    rows.forEach((row) => logger.write(`${row}\n`));
    console.log(`✅ Page ${currentPage}: Extracted ${rows.length} rows`);

    // Check if "Next" button is disabled
    const isNextDisabled = await page.evaluate(() => {
      const next = document.querySelector("li.pagination-next");
      return next?.classList.contains("disabled");
    });

    if (isNextDisabled) {
      console.log("⛔ 'Next' button disabled. Scraping complete.");
      break;
    }

    try {
      console.log("⏭️ Navigating to next page...");
      await page.evaluate(() => {
        document.querySelector("li.pagination-next > a").click();
      });
      
      // Wait for new page to load
      await page.waitForFunction(
        () => {
          const spinner = document.querySelector(".loading-spinner");
          return !spinner || spinner.style.display === "none";
        },
        { timeout: 60000, polling: 1000 }
      );
      
      await page.waitForSelector("table.table-striped tbody tr", { timeout: 30000 });
      
      // Human-like delay
      await page.waitForTimeout(Math.floor(Math.random() * 8000) + 2000);
      currentPage++;
    } catch (e) {
      console.warn(`⚠️ Page navigation failed: ${e.message}`);
      await page.screenshot({ path: `navigation-failure-page-${currentPage}.png` });
      break;
    }
  }

  logger.close();
  await browser.close();
  console.log("🎉 Scraping finished successfully.");
})();
