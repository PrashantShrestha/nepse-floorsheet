const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const randomUseragent = require("random-useragent");

puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
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

  const date = new Date().toISOString().split("T")[0];
  const csvFilePath = `floor_sheet_data_${date}.csv`;
  const writeStream = fs.createWriteStream(csvFilePath, { flags: "a" });

  // Write CSV headers if file is new or empty
  if (!fs.existsSync(csvFilePath) || fs.statSync(csvFilePath).size === 0) {
    writeStream.write("SN,ContractNo,Symbol,Buyer,Seller,Quantity,Rate,Amount\n");
  }

  console.log("Starting floor sheet scraping...");

  try {
    await page.goto("https://nepalstock.com.np/floor-sheet", {
      waitUntil: "networkidle2",
    });

    // Select 500 rows per page
    await page.waitForSelector("div.box__filter--field select", {
      timeout: 20000,
    });
    await page.select("div.box__filter--field select", "500");

    // Wait for the search button and click it
    const searchButton = await page.waitForSelector("button.box__filter--search", {
      timeout: 20000,
    });

    // Wait for data to load after search
    await Promise.all([
      searchButton.click(),
      page.waitForFunction(
        () =>
          document.querySelectorAll("table.table-striped tbody tr").length >= 500,
        { timeout: 30000 }
      ),
    ]);
  } catch (error) {
    console.error(`Initial page setup failed: ${error.message}`);
    await browser.close();
    return;
  }

  let pageCounter = 1;

  while (true) {
    console.log(`Scraping page ${pageCounter}...`);

    try {
      await page.waitForSelector("table.table-striped tbody tr", {
        timeout: 20000,
      });

      // Extract rows from the current page
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll("table.table-striped tbody tr"))
          .map((tr) =>
            Array.from(tr.querySelectorAll("td"))
              .map((td) =>
                `"${td.textContent
                  .trim()
                  .replace(/"/g, '""')
                  .replace(/\.00$/, "")}"`
              )
              .join(",")
          )
          .filter((row) => row.length > 0)
      );

      // Write rows to CSV
      rows.forEach((row) => writeStream.write(`${row}\n`));
      console.log(`Extracted ${rows.length} rows from page ${pageCounter}`);
    } catch (error) {
      console.warn(`Error extracting rows from page ${pageCounter}: ${error.message}`);
      break;
    }

    // Check if "Next" button is disabled
    const isNextDisabled = await page.evaluate(() => {
      const nextLi = document.querySelector("li.pagination-next");
      return nextLi?.classList.contains("disabled") || false;
    });

    if (isNextDisabled) {
      console.log("No more pages to scrape. Exiting.");
      break;
    }

    try {
      const nextSelector = "li.pagination-next > a";

      // Click the next button and wait for table to refresh
      await Promise.all([
        page.click(nextSelector),
        page.waitForFunction(() => {
          const table = document.querySelector("table.table-striped tbody");
          return table && table.children.length > 0;
        }, { timeout: 60000 }),
      ]);

      // Random delay to mimic human interaction
      const delay = Math.floor(Math.random() * 8000) + 2000;
      await page.waitForTimeout(delay);
      pageCounter++;
    } catch (error) {
      console.warn(`Error going to next page: ${error.message}`);
      break;
    }
  }

  writeStream.close();
  await browser.close();
  console.log("Scraping finished.");
})();
