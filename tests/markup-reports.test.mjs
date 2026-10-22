import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { markupCsv, markupPdf } from "../apps/opendraft/src/markup-reports.ts";

const timestamp = "2026-10-21T12:00:00.000Z";
const mark = (id = "one", extra = {}) => ({
  id,
  pageIndex: 0,
  kind: "rectangle",
  points: [
    [40, 40],
    [180, 120],
  ],
  color: [1, 0, 0],
  width: 2,
  opacity: 0.75,
  contents: "Confirm detail",
  author: "Reviewer",
  status: "open",
  locked: false,
  createdAt: timestamp,
  modifiedAt: timestamp,
  ...extra,
});
const comment = (id, extra = {}) => ({
  id, author: "Comment reviewer", contents: "Review comment", createdAt: timestamp, modifiedAt: timestamp, ...extra,
});

// Independent small RFC4180 parser to verify delimiter/newline handling, not string fragments alone.
function parseCsv(csv) {
  const rows = [];
  let row = [],
    value = "",
    quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(value);
      value = "";
    } else if (c === "\r" && csv[i + 1] === "\n" && !quoted) {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      i++;
    } else value += c;
  }
  assert.equal(quoted, false);
  return rows;
}

test("CSV round-trips quoted newlines and neutralizes formula cells without changing model", () => {
  const marks = [
    mark("one", {
      contents: '  =SUM(1,2)\n"review", next',
      author: "\t\r@external",
    }),
    mark("two", { contents: "-1+2", author: " +cmd" }),
  ];
  const before = structuredClone(marks);
  const rows = parseCsv(
    markupCsv('\ufeff=HYPERLINK("https://example.invalid")', 2, marks),
  );
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.length === 25));
  assert.deepEqual(rows[1].slice(0, 4), [
    "summary",
    '\'\ufeff=HYPERLINK("https://example.invalid")',
    "2",
    "2",
  ]);
  assert.equal(rows[2][7], "'\t\r@external");
  assert.equal(rows[2][10], '\'  =SUM(1,2)\n"review", next');
  assert.equal(rows[3][7], "' +cmd");
  assert.equal(rows[3][10], "'-1+2");
  assert.deepEqual(marks, before);
  const empty = parseCsv(markupCsv("empty.pdf", 1, []));
  assert.equal(empty.length, 2);
  assert.equal(empty[1][3], "0");
});

test("PDF report paginates long fields and independently retains every record and final contents", async () => {
  const marks = Array.from({ length: 25 }, (_, index) =>
    mark(`record-${index}`, {
      pageIndex: index % 2,
      contents:
        `Record ${index} ` + "Long review detail ".repeat(20) + ` END-${index}`,
      author: `Reviewer ${index}`,
      locked: index === 24,
      status: index === 24 ? "accepted" : "open",
    }),
  );
  const before = structuredClone(marks),
    bytes = await markupPdf("synthetic drawings.pdf", 2, marks);
  assert.deepEqual(marks, before);
  const task = getDocument({
    data: bytes.slice(),
    standardFontDataUrl:
      path
        .resolve("node_modules/pdfjs-dist/standard_fonts")
        .replaceAll("\\", "/") + "/",
  });
  try {
    const pdf = await task.promise;
    assert.ok(pdf.numPages > 3);
    const text = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber),
        content = await page.getTextContent();
      text.push(
        content.items
          .filter((item) => "str" in item)
          .map((item) => item.str)
          .join(" "),
      );
      for (const item of content.items)
        if ("str" in item && item.str) {
          assert.ok(item.transform[4] >= 41);
          assert.ok(
            item.transform[5] >= 23 && item.transform[5] <= 801,
            `clipped text ${item.str}`,
          );
          assert.ok(
            item.transform[4] + item.width <= 554,
            `text exceeds report width: ${item.str}`,
          );
        }
    }
    const all = text.join(" ");
    assert.match(all, /Authored markups: 25/);
    assert.match(all, /accepted: 1/);
    for (let index = 0; index < 25; index++) {
      assert.ok(all.includes(`ID: record-${index}`));
      assert.ok(all.includes(`END-${index}`));
    }
    assert.match(all, /Locked: yes/);
    assert.match(all, /Coordinates: 40,40 ; 180,120/);
  } finally {
    await task.destroy();
  }
});

test("reports reject invalid or excessive fields and PDF rejects unsupported characters explicitly", async () => {
  assert.throws(() => markupCsv("doc.pdf", 0, [mark()]), /page count/);
  assert.throws(() => markupCsv("x".repeat(1001), 1, []), /filename/);
  assert.throws(() =>
    markupCsv("doc.pdf", 1, [mark("one", { contents: "x".repeat(10001) })]),
  );
  assert.throws(
    () =>
      markupCsv(
        "doc.pdf",
        1,
        Array.from({ length: 5001 }, (_, i) => mark(`row-${i}`)),
      ),
    /at most/,
  );
  await assert.rejects(markupPdf("工程.pdf", 1, []), /WinAnsi/);
  await assert.rejects(
    markupPdf("doc.pdf", 1, [mark("one", { author: "Reviewer 水" })]),
    /WinAnsi/,
  );
  // CSV is UTF-8 and can preserve document labels that the PDF report font cannot encode.
  assert.ok(markupCsv("工程.pdf", 1, []).includes("工程.pdf"));
});

test('stamp reports retain appearance names even when visible text defaults from the name', async()=>{
  const stamp=mark('stamp-report',{kind:'stamp',stampName:'ForComment',contents:''});
  const csv=markupCsv('review.pdf',1,[stamp]);
  const rows=parseCsv(csv);
  assert.equal(rows[0][17],'Stamp appearance');
  assert.equal(rows[2][17],'ForComment');
  const task=getDocument({data:await markupPdf('review.pdf',1,[stamp])});
  try {
    const doc=await task.promise,strings=[];
    for(let index=1;index<=doc.numPages;index++) strings.push(...(await(await doc.getPage(index)).getTextContent()).items.filter(item=>'str'in item).map(item=>item.str));
    assert.match(strings.join(' '),/Stamp appearance: ForComment/);
    assert.match(strings.join(' '),/no verified digital signature/);
  } finally {await task.destroy();}
});


test('reports retain group IDs for all members without merging their individual records',async()=>{
  const marks=[mark('group-a',{groupId:'review-set'}),mark('group-b',{groupId:'review-set',kind:'ellipse'})];
  const rows=parseCsv(markupCsv('groups.pdf',1,marks));
  assert.equal(rows[0][18],'Group ID');
  assert.equal(rows[2][18],'review-set'); assert.equal(rows[3][18],'review-set');
  assert.equal(rows[2][4],'group-a'); assert.equal(rows[3][4],'group-b');
  const task=getDocument({data:await markupPdf('groups.pdf',1,marks)});
  try {const doc=await task.promise,strings=[];for(let n=1;n<=doc.numPages;n++)strings.push(...(await(await doc.getPage(n)).getTextContent()).items.filter(item=>'str'in item).map(item=>item.str));assert.equal((strings.join(' ').match(/Group ID: review-set/g)??[]).length,2);}finally{await task.destroy();}
});


test('reports include resolved layer state and reject unknown layer references',async()=>{
 const marks=[mark('layer-mark',{layerId:'review-layer'})],layers=[{id:'review-layer',name:'Mechanical review',visible:false,locked:true}];
 const rows=parseCsv(markupCsv('layers.pdf',1,marks,layers));
 assert.deepEqual(rows[2].slice(19,23),['review-layer','Mechanical review','false','true']);
 assert.throws(()=>markupCsv('layers.pdf',1,marks,[]),/layer/i);
 const task=getDocument({data:await markupPdf('layers.pdf',1,marks,layers)});
 try{const doc=await task.promise,strings=[];for(let n=1;n<=doc.numPages;n++)strings.push(...(await(await doc.getPage(n)).getTextContent()).items.filter(item=>'str'in item).map(item=>item.str));assert.match(strings.join(' '),/Layer: Mechanical review/);}finally{await task.destroy();}
});

test('CSV appends lossless comment evidence without changing the preceding columns or model',()=>{
 const comments=[
  comment('comment-root',{author:'Reviewer 水',contents:'=SUM(1,2)\n"quoted", @external'}),
  comment('comment-reply',{parentId:'comment-root',author:'Reviewer 2',contents:'Follow up\nsecond line'}),
 ];
 const marks=[mark('threaded',{comments}),mark('without-comments')],before=structuredClone(marks);
 const rows=parseCsv(markupCsv('comments.pdf',1,marks));
 assert.ok(rows.every(row=>row.length===25));
 assert.deepEqual(rows[0].slice(23),['Comment count','Comments JSON']);
 assert.deepEqual(rows[1].slice(4),Array(21).fill(''));
 assert.equal(rows[2][23],'2');assert.deepEqual(JSON.parse(rows[2][24]),comments);
 assert.equal(rows[3][23],'0');assert.deepEqual(JSON.parse(rows[3][24]),[]);
 assert.equal(rows[2][4],'threaded');assert.equal(rows[2][10],'Confirm detail');
 assert.deepEqual(marks,before);
});

test('PDF comment reports independently retain parent relationships, authors, timestamps and paginated final bodies',async()=>{
 const comments=Array.from({length:8},(_,index)=>comment(`comment-${index}`,{
  ...(index?{parentId:`comment-${index-1}`} : {}),
  author:`Thread reviewer ${index}`,
  contents:`Comment body ${index} `+'Check construction detail '.repeat(30)+` FINAL-COMMENT-${index}`,
 }));
 const marks=[mark('owning-markup',{comments})],before=structuredClone(marks);
 const task=getDocument({data:await markupPdf('threaded.pdf',1,marks),standardFontDataUrl:path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\','/')+'/'});
 try {
  const pdf=await task.promise,strings=[];assert.ok(pdf.numPages>=3);
  for(let n=1;n<=pdf.numPages;n++)strings.push(...(await(await pdf.getPage(n)).getTextContent()).items.filter(item=>'str'in item).map(item=>item.str));
  const text=strings.join(' ');
  assert.match(text,/Comments: 8/);assert.match(text,/Reply to markup: owning-markup/);
  for(let n=0;n<comments.length;n++){
   assert.ok(text.includes(`Comment ID: comment-${n}`));
   assert.ok(text.includes(`Comment author: Thread reviewer ${n}`));
   assert.ok(text.includes(`FINAL-COMMENT-${n}`));
   if(n)assert.ok(text.includes(`Reply to comment: comment-${n-1}`));
  }
  assert.ok(text.includes(`Comment created: ${timestamp}`));
  assert.ok(text.includes(`Modified: ${timestamp}`));
 }finally{await task.destroy();}
 assert.deepEqual(marks,before);
});

test('reports budget comment text before rendering and preserve Unicode CSV while PDF fails explicitly',async()=>{
 const excessive=Array.from({length:3},(_,i)=>mark(`budget-${i}`,{comments:Array.from({length:100},(_,j)=>comment(`budget-${i}-${j}`,{contents:'x'.repeat(10000)}))}));
 assert.throws(()=>markupCsv('budget.pdf',1,excessive),/text or geometry budget/);
 await assert.rejects(markupPdf('budget.pdf',1,excessive),/text or geometry budget/);
 const unicode=[mark('unicode-comment',{comments:[comment('unicode',{contents:'Review 水'})]})];
 assert.equal(JSON.parse(parseCsv(markupCsv('unicode.pdf',1,unicode))[2][24])[0].contents,'Review 水');
 await assert.rejects(markupPdf('unicode.pdf',1,unicode),/WinAnsi/);
});
