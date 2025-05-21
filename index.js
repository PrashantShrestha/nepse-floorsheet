const fs = require("fs");
const puppeteer = require("puppeteer");

const logStream = fs.createWriteStream("log.txt", { flags: "a" });
function log(message) {
  const time = new Date().toISOString();
  const full = `[${time}] ${message}`;
  console.log(full);
  logStream.write(full + "\n");
}

(async () => {
  const browser = await puppeteer.launch({ headless: "new" }); // or true/false as needed
  const page = await browser.newPage();

  try {
    await page.goto("https://example.com/your-trade-data", { waitUntil: "domcontentloaded" });

    let pageIndex = 1;

    while (true) {
      log(`🔄 Processing page ${pageIndex}`);

      // TODO: Add your data scraping logic here
      const tableData = await page.evaluate(() => {
        // Sample extraction logic
        const rows = Array.from(document.querySelectorAll("table tbody tr"));
        return rows.map(row => {
          return Array.from(row.querySelectorAll("td")).map(cell => cell.innerText.trim());
        });
      });

      log(`✅ Scraped ${tableData.length} rows from page ${pageIndex}`);

      // Check if we are on the last page
      const isLastPage = await page.evaluate(() => {
        const paginationText = document.querySelector("li.small-screen")?.textContent || "";
        const match = paginationText.match(/(\d+)\s*\/\s*(\d+)/); // e.g., "177 / 177"
        if (!match) return true; // fallback: assume it's last page if can't parse
        const [_, current, total] = match.map(Number);
        return current === total;
      });

      if (isLastPage) {
        log("⛔ Reached last page. Stopping.");
        break;
      }

      // Try clicking the next button
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
          page.click("li.pagination-next a")
        ]);
        pageIndex++;
      } catch (e) {
        log(`⚠️ Failed to navigate to next page: ${e.message}`);
        break;
      }
    }
  } catch (err) {
    log(`❌ Unhandled error: ${err.message}`);
  } finally {
    await browser.close();
    logStream.end();
  }
})();
