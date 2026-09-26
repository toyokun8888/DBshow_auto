const assert = require("assert");
const { localTimestamp, parseFolderHtml, validateFolder } = require("./rapidgator_daily_delta");

const folder = { folderId: "3330879", folderName: "movie", dbMaxPage: 6278 };
const itemRows = [
  '<tr><td><a href="/file/0123456789abcdef/FC2-PPV-4981113.mp4.html">file</a></td></tr>',
  ...Array.from({ length: 99 }, (_, index) =>
    `<tr><td><a href="/folder/${1000 + index}/nested.html">folder</a></td></tr>`
  ),
].join("\n");
const html = `
  <html><body><table class="items"><tbody>
    ${itemRows}
  </tbody></table>
  <div class="summary">Total objects in folder 609800</div>
  <div class="rapidPager"><ul class="yiiPager"><li class="last">
    <a href="/folder/3330879/movie.html?page=6098">Last &gt;&gt;</a>
  </li></ul></div>
  </body></html>`;

const parsed = parseFolderHtml(html, folder, 1);
assert.strictEqual(parsed.itemRows, 100);
assert.strictEqual(parsed.fileUrls.length, 1);
assert.strictEqual(parsed.lastPage, 6098);
assert.strictEqual(parsed.totalItems, 609800);
assert.strictEqual(parsed.paginationDetected, true);
assert.strictEqual(parsed.fileUrls[0], "https://rapidgator.net/file/0123456789abcdef/FC2-PPV-4981113.mp4.html");
assert.deepStrictEqual(validateFolder({
  folder_id: "61729",
  folder_name: "MangaOK",
  db_max_page: "1141",
}), {
  folderId: "61729",
  folderName: "MangaOK",
  dbMaxPage: 1141,
});
assert.throws(() => validateFolder({ folder_id: "1", folder_name: "../unsafe" }), /Unsafe/);
assert.throws(
  () => validateFolder({ folder_id: "61729", folder_name: "MangaOK", db_max_page: "0" }),
  /Unsafe DB page range/
);
assert.strictEqual(localTimestamp(new Date("2026-09-22T15:30:45.000Z")), "20260923003045");
assert.throws(() => parseFolderHtml("<html>captcha</html>", folder, 1), /CAPTCHA/);
assert.throws(
  () => parseFolderHtml(
    "<table class='items'><tbody><tr><td>missing</td></tr></tbody></table><div class='summary'>Total objects in folder 1</div>",
    folder,
    1
  ),
  /Missing item link/
);
assert.throws(
  () => parseFolderHtml(
    "<table class='items'><tbody><tr><td><a href='/news'>unexpected</a></td></tr></tbody></table><div class='summary'>Total objects in folder 1</div>",
    folder,
    1
  ),
  /Unexpected item link/
);
const withoutPagination = parseFolderHtml(
  "<table class='items'><tbody><tr><td><a href='/file/abcdef0123456789/item.html'>file</a></td></tr></tbody></table><div class='summary'>Total objects in folder 1</div>",
  { folderId: "1", folderName: "single", dbMaxPage: 1 },
  1
);
assert.strictEqual(withoutPagination.paginationDetected, false);
assert.throws(
  () => parseFolderHtml(
    `<table class="items"><tbody>${itemRows}</tbody></table><div class="summary">Total objects in folder 101</div>`,
    folder,
    1
  ),
  /Missing explicit last-page link/
);
assert.throws(
  () => parseFolderHtml(
    `<table class="items"><tbody>${itemRows}</tbody></table>
     <div class="summary">Total objects in folder 101</div>
     <div class="rapidPager"><ul class="yiiPager"><li class="last">
       <a href="/folder/3330879/movie.html?page=3">Last &gt;&gt;</a>
     </li></ul></div>`,
    folder,
    1
  ),
  /Invalid last-page link/
);

process.stdout.write("rapidgator_daily_delta tests passed\n");
