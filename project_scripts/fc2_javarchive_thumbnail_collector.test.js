const assert = require("assert");

const {
  detectImage,
  extractPageData,
  looksLikeBlockingPage,
  maintenanceWindowDelayMs,
  pageUrl,
  resolveBackfillTotalPages,
  validateRemoteUrl,
} = require("./fc2_javarchive_thumbnail_collector");

function listingHtml(items, lastPage = 1) {
  return `
    <html><body>
      <aside><li><a href="/FC2-PPV-9999999"><img src="https://img2.javstore.net/side.jpg"></a></li></aside>
      <div class="news_1n"><ul>${items.join("\n")}</ul></div>
      <a href="/81-av-uncensored-page-${lastPage}-cn.html">last</a>
    </body></html>
  `;
}

function validItem(productId = "4979448") {
  return `<li><a href="/1-FC2-PPV-${productId}-pn.html" title="FC2 PPV ${productId}"><img src="http://img2.javstore.net/${productId}.jpg"></a><span class="news_date">20/09/2026</span></li>`;
}

function run() {
  const parsed = extractPageData(listingHtml([validItem()], 5118), 1);
  assert.strictEqual(parsed.itemCount, 1);
  assert.strictEqual(parsed.detectedLastPage, 5118);
  assert.strictEqual(parsed.candidates.length, 1);
  assert.strictEqual(parsed.candidates[0].product_id, "4979448");
  assert.strictEqual(parsed.candidates[0].image_url, "https://img2.javstore.net/4979448.jpg");
  assert.strictEqual(parsed.candidates[0].source_article_url, "https://javarchive.com/1-FC2-PPV-4979448-pn.html");

  const legacyHostItem = validItem("3068263").replace("img2.javstore.net", "img.javstore.net");
  const legacyHostParsed = extractPageData(listingHtml([legacyHostItem]), 3247);
  assert.strictEqual(legacyHostParsed.candidates.length, 1);
  assert.strictEqual(legacyHostParsed.candidates[0].product_id, "3068263");
  assert.strictEqual(
    legacyHostParsed.candidates[0].image_url,
    "https://img.javstore.net/3068263.jpg"
  );

  const conflicting = validItem().replace("title=\"FC2 PPV 4979448\"", "title=\"FC2 PPV 1234567\"");
  assert.strictEqual(extractPageData(listingHtml([conflicting]), 1).candidates.length, 0);

  const wrongImageHost = validItem().replace("img2.javstore.net", "example.com");
  assert.strictEqual(extractPageData(listingHtml([wrongImageHost]), 1).candidates.length, 0);

  const wrongArticleHost = validItem().replace('href="/', 'href="https://example.com/');
  assert.strictEqual(extractPageData(listingHtml([wrongArticleHost]), 1).candidates.length, 0);

  assert.throws(() => extractPageData("<html>captcha</html>", 1), /CAPTCHA/);
  assert.strictEqual(looksLikeBlockingPage(Buffer.from("<html>cf-chl-test</html>")), true);
  assert.strictEqual(looksLikeBlockingPage(Buffer.from("ordinary image response")), false);
  assert.throws(() => validateRemoteUrl("http://javarchive.com/a", new Set(["javarchive.com"]), "page"), /HTTPS/);
  assert.throws(() => validateRemoteUrl("https://example.com/a", new Set(["javarchive.com"]), "page"), /not approved/);
  assert.strictEqual(pageUrl(1), "https://javarchive.com/81-av-uncensored-cn.html");
  assert.strictEqual(pageUrl(2), "https://javarchive.com/81-av-uncensored-page-2-cn.html");
  assert.strictEqual(resolveBackfillTotalPages(5119, 6000, 3716), 3716);
  assert.strictEqual(resolveBackfillTotalPages(3600, 6000, 3716), 3600);
  assert.throws(() => resolveBackfillTotalPages(6001, 6000, 3716), /outside the approved range/);

  assert.strictEqual(detectImage(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg").extension, ".jpg");
  assert.strictEqual(
    detectImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png").extension,
    ".png"
  );
  assert.throws(() => detectImage(Buffer.from("not image"), "text/html"), /content-type/);

  assert.strictEqual(maintenanceWindowDelayMs(new Date(2026, 8, 20, 7, 54, 59)), 0);
  assert.strictEqual(maintenanceWindowDelayMs(new Date(2026, 8, 20, 8, 0, 0)), 60 * 60 * 1000);
  assert.strictEqual(maintenanceWindowDelayMs(new Date(2026, 8, 20, 21, 0, 0)), 75 * 60 * 1000);
  assert.strictEqual(maintenanceWindowDelayMs(new Date(2026, 8, 20, 22, 15, 0)), 0);

  process.stdout.write("fc2_javarchive_thumbnail_collector tests passed\n");
}

run();
