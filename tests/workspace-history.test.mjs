import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceHistory } from "../apps/opendraft/src/workspace-history.ts";
import { calibrateScale } from "../apps/opendraft/src/measurements.ts";
const pages = [{ sourceId: "source", pageIndex: 0, rotation: 0 }];
const mark = {
  id: "note",
  pageIndex: 0,
  kind: "rectangle",
  points: [
    [10, 10],
    [50, 50],
  ],
  color: [1, 0, 0],
  width: 2,
  opacity: 1,
  contents: "Review",
  author: "Tester",
  status: "open",
  locked: false,
  createdAt: "2026-10-21T12:00:00.000Z",
  modifiedAt: "2026-10-21T12:00:00.000Z",
};
test("undo restores pages and annotations atomically with defensive copies and branching", () => {
  const history = new WorkspaceHistory(pages);
  history.commit([{ ...pages[0], rotation: 90 }], [mark]);
  const copy = history.markups;
  copy[0].points[0][0] = 900;
  assert.equal(history.markups[0].points[0][0], 10);
  history.undo();
  assert.equal(history.pages[0].rotation, 0);
  assert.deepEqual(history.markups, []);
  history.redo();
  assert.equal(history.pages[0].rotation, 90);
  assert.equal(history.markups.length, 1);
  history.undo();
  history.commit([{ ...pages[0], rotation: 180 }]);
  assert.equal(history.canRedo, false);
  assert.throws(() => history.commit(pages, [{ ...mark, pageIndex: 1 }]));
  assert.equal(history.pages[0].rotation, 180);
});
test("workspace history retains at most 100 reversible commands", () => {
  const history = new WorkspaceHistory(pages);
  for (let i = 1; i <= 105; i++)
    history.commit([{ ...pages[0], rotation: (i % 4) * 90 }]);
  let undone = 0;
  while (history.canUndo) {
    history.undo();
    undone++;
  }
  assert.equal(undone, 100);
  assert.equal(history.pages[0].rotation, 90);
});

test("takeoff calibration and records participate in atomic undo, validation and defensive snapshots", () => {
  const scale = calibrateScale({
    id: "reviewed",
    pageIndex: 0,
    points: [
      [0, 0],
      [72, 0],
    ],
    distance: 10,
    unit: "ft",
  });
  const takeoff = {
    scales: [scale],
    records: [
      {
        id: "length",
        label: "Main run",
        pageIndex: 0,
        kind: "length",
        points: [
          [0, 0],
          [144, 0],
        ],
        unit: "ft",
      },
    ],
  };
  const history = new WorkspaceHistory(pages);
  history.commit(pages, [mark], takeoff);
  const copy = history.takeoff;
  copy.scales[0].reference.points[0][0] = 90;
  copy.records[0].points[1][0] = 500;
  assert.equal(history.takeoff.scales[0].reference.points[0][0], 0);
  assert.equal(history.takeoff.records[0].points[1][0], 144);
  history.undo();
  assert.deepEqual(history.takeoff, { scales: [], records: [] });
  assert.deepEqual(history.markups, []);
  history.redo();
  assert.equal(history.markups.length, 1);
  assert.equal(history.takeoff.records.length, 1);
  assert.throws(
    () =>
      history.commit(pages, [mark], {
        ...takeoff,
        scales: [{ ...scale, metersPerPdfUnit: 99 }],
      }),
    /reference evidence/,
  );
  assert.equal(
    history.takeoff.scales[0].metersPerPdfUnit,
    scale.metersPerPdfUnit,
  );
  assert.throws(
    () =>
      new WorkspaceHistory(pages, [], {
        ...takeoff,
        records: [{ ...takeoff.records[0], pageIndex: 2 }],
      }),
  );
  takeoff.records[0].points[1][0] = 1000;
  assert.equal(history.takeoff.records[0].points[1][0], 144);
});

test('layer metadata and assignment are atomic history state with defensive copies and invalid-candidate preservation',()=>{
 const pages=[{sourceId:'source',pageIndex:0,rotation:0}],layer={id:'review',name:'Review',visible:true,locked:false};
 const mark={id:'layer-mark',pageIndex:0,kind:'rectangle',layerId:'review',points:[[10,10],[30,30]],color:[1,0,0],width:2,opacity:1,contents:'Review',author:'A',status:'open',locked:false,createdAt:'2026-10-21T12:00:00.000Z',modifiedAt:'2026-10-21T12:00:00.000Z'};
 const history=new WorkspaceHistory(pages,[mark],undefined,[layer]);
 history.layers[0].name='Caller mutation';assert.equal(history.layers[0].name,'Review');
 history.commit(pages,[mark],undefined,[{...layer,visible:false,locked:true}]);
 assert.equal(history.layers[0].locked,true);history.undo();assert.equal(history.layers[0].visible,true);history.redo();assert.equal(history.layers[0].visible,false);
 const before=history.layers;assert.throws(()=>history.commit(pages,[mark],undefined,[]));assert.deepEqual(history.layers,before);
});
