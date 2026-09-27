# 02 — The web UI (`apps/web`)

`apps/web` is FreeCAD's desktop frontend in the browser: the FreeCAD 1.x main window — menu bar,
toolbars, Combo View (Model and Tasks), the 3D view with its navigation cube, MDI tabs, the Report
view, the Python console and the status bar — driving FreeCAD's application core through the
FreeCAD API (`@fab-cad/client`). Menu texts, tooltips, shortcuts and icons are FreeCAD's own,
read from the fork's GUI sources (`tooling/icons/sync.ts`).

```sh
bun run dev                                   # vite on http://127.0.0.1:5180
FreeCADApiServer --listen ws://127.0.0.1:8765/ &
open "http://127.0.0.1:5180/?ws=ws://127.0.0.1:8765/"
open "http://127.0.0.1:5180/?mock=1"          # the in-page mock, no server
```

| URL                      | Backend                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `?ws=<url>`              | a `FreeCADApiServer` (or `FreeCADApi.startServer()` in a desktop FreeCAD), dialed directly                |
| _(served by bridge)_     | `@fab-cad/bridge`: `GET /health` identifies it, `POST /sessions` starts a FreeCAD, `/ws?session=` proxies |
| `?bridge=<url>`          | the same with the bridge elsewhere                                                                        |
| `?wasm=1`                | `freecad_api.wasm` in a Web Worker (`@fab-cad/freecad-wasm`); a clear message when the build is missing   |
| `?mock=1` / `?mock=demo` | `@fab-cad/mock-server`'s dispatcher in the page (demos, smoke tests)                                      |

Without a parameter the page asks its origin whether it is a bridge; otherwise the Start page
offers the connections. A restarted server (token change) reloads the model, clears the selection,
closes task dialogs and leaves edit mode; a closed socket shows a banner with _Reconnect_.

## Layers

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ ui/         React: MenuBar, Toolbars, ComboView (TreeView, PropertyView,     │
 │             TaskView), View3D, StartPage, Output (Report, Python), StatusBar │
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ workbenches/  menus + toolbars per workbench (Workbench.cpp transcribed)     │
 │ commands/     registry (FreeCAD names) + Std / Part / PartDesign / Sketcher  │
 │ tasks/        task dialogs (transactions)   sketcher/  edit mode, tools      │
 │ viewer/       three.js 3D view (not React)  properties/ tree/  pure models   │
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ state/        zustand stores                                                 │
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ @fab-cad/client: FreeCADClient (commands, events) + DocumentStore (mirror)   │
 └──────────────────────────────────────────────────────────────────────────────┘
```

### Stores (`src/state`)

| Store              | Holds                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`          | the `Connection` (client + `DocumentStore`), connection status, a `version` bumped on every model change (React re-renders on it), undo stacks per document, restarts |
| `app`              | active workbench, active document (MDI tab), open tabs, panels, Combo View tab, property view tab, the open task dialog, edit mode, F2 rename                         |
| `selection`        | FreeCAD's selection: `(doc, object, sub-element, picked point)` items and one preselection                                                                            |
| `console`          | Report view entries (message / warning / error / log) and Python console lines, history                                                                               |
| `viewprops`        | view provider properties (View tab: display mode, colours, line width, transparency…) — the headless server has no GUI document                                       |
| `view3d`           | draw style, orthographic/perspective, navigation style (persisted), axis cross, view dimensions, the viewer handle commands use                                       |
| `dialogs`          | modal dialogs (prompt / message / confirm / custom) as promises                                                                                                       |
| `activeBody`       | the active Part Design body per document                                                                                                                              |
| `sketcher/session` | the sketch in edit mode: geometry and constraints, active tool, selection inside the sketch                                                                           |

The model itself is `DocumentStore` from `@fab-cad/client`: loaded once, then refreshed from
events; meshes are cached by `(doc, object, revision)`. The 3D view subscribes to its changes
(`onModelChange`) and fetches only stale tessellations.

### Command registry (`src/commands`)

Every menu item, toolbar button and shortcut is a FreeCAD command name. `commandInfo(id)` merges

- **FreeCAD's metadata** — `src/generated/freecad-commands.json`: `sMenuText`, `sToolTipText`,
  `sPixmap`, `sAccel` of each `Command("…")` constructor (and the Python commands'
  `GetResources()`), extracted by `tooling/icons/sync.ts`;
- **the web definition** — `CommandDef {isActive(ctx), isChecked(ctx), run(ctx), items}` registered
  by `std.ts`, `part.ts`, `partdesign.ts`, `sketcher.ts`.

A FreeCAD command without a definition is still shown, disabled, with "Not available in the web UI
yet" in its tooltip. `items` makes a group command (a toolbar drop-down, e.g. `Std_DrawStyle`,
`Std_ViewGroup`, `Part_CompCompoundTools`). `CommandContext` is a snapshot of the stores
(`commands/context.ts`) so enabling is a pure function (unit-tested). Accelerators, including
chords (`V, F`, `V, 1`…), are dispatched by `ui/shortcuts.ts` from the same metadata; an edit mode
(the Sketcher) can take keys first.

### Workbench definitions (`src/workbenches`)

`StdWorkbench::setupMenuBar/setupToolBars/setupContextMenu` and the Part, Part Design and
Sketcher `Workbench.cpp` transcribed: the workbench menus go before `&Windows`, Part Design
replaces `Std_DuplicateSelection`, Part and Part Design add `Part_ColorPerFace` to View; the
Sketcher's edit-mode toolbars (`DefaultVisibility::Unavailable`) appear while a sketch is edited.

### From a GUI command to API calls

FreeCAD's GUI commands run Python (`doCommand`) inside `openCommand`/`commitCommand`. The web
commands do the same work with API calls inside one transaction and echo the Python FreeCAD would
have printed to the console:

| Command                        | API calls                                                                                                                                                                                                                      | Echo                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `Part_Box`                     | `OpenTransaction("Cube")`, `AddObject(Part::Box, label "Cube")`, `Recompute`, `CommitTransaction`; fit all                                                                                                                     | `App.ActiveDocument.addObject("Part::Box","Box")` …                   |
| property edit                  | `OpenTransaction("Edit Box.Length")`, `SetProperties({Length})`, `Recompute`, `CommitTransaction`                                                                                                                              | `FreeCAD.getDocument('Unnamed').getObject('Box').Length = '25.40 mm'` |
| `=` in a property              | `SetExpression(path, expr)` in the same kind of transaction                                                                                                                                                                    | `….setExpression('Height', u'Length * 2')`                            |
| `Part_Cut` / `Fuse` / `Common` | one transaction: `AddObject(Part::Cut, {Base, Tool})` (`MultiFuse`/`MultiCommon` with `Shapes`), `SetProperties(Visibility=False)` on the inputs                                                                               | FreeCAD 0.19's explicit form                                          |
| `Std_Undo` / `Std_Redo`        | `Undo` / `Redo`; menu text from `GetUndoStack` (`Undo Edit Box.Length`)                                                                                                                                                        | —                                                                     |
| `Std_Delete`                   | `RemoveObject` per object in one transaction                                                                                                                                                                                   | `App.getDocument('Unnamed').removeObject('Box')`                      |
| `PartDesign_Body`              | `AddObject(PartDesign::Body)`; the origin hidden with `RunPython` (FreeCAD's GUI hides it)                                                                                                                                     | FreeCAD's body lines                                                  |
| `PartDesign_Pad`               | `OpenTransaction("Pad")`, `RunPython(body.newObject('PartDesign::Pad') …, profile, hide sketch and previous tip)`, task dialog edits with `SetProperties` + `Recompute`, OK = `CommitTransaction`, Cancel = `AbortTransaction` | FreeCAD's Pad lines                                                   |
| Sketcher tools / constraints   | one transaction per operation: `RunPython("ActiveSketch.addGeometry(Part.LineSegment(...)) …; ActiveSketch.solve()")`, then the sketch read back with `RunPython` (JSON)                                                       | the same lines                                                        |
| `Std_Open` / drop              | `OpenDocumentBytes` (.FCStd) or `NewDocument` + `Import` with bytes                                                                                                                                                            | `FreeCAD.openDocument(…)`, `ImportGui.insert(…)`                      |
| `Std_Save` / `Std_SaveAs`      | `SaveDocument` / `SaveDocumentAs` when the server's disk is the user's, else `SaveDocumentBytes` → download                                                                                                                    | `App.getDocument(…).save()`                                           |
| `Std_Export`                   | `Export(objects, format)` → download                                                                                                                                                                                           | `ImportGui.export(__objs__, …)`                                       |
| selection                      | none (client-side)                                                                                                                                                                                                             | `# Gui.Selection.addSelection('Unnamed','Box','Face2',x,y,z)`         |

View provider properties (colours, display mode) and camera commands have no API counterpart and
stay in the page; their echo (`Gui.…`) shows what FreeCAD would run.

## The 3D view (`src/viewer`)

- **Scene**: one `ObjectView` per drawable object (geometry, visible, not a Part Design body — its
  features draw): faces as an indexed mesh with area-weighted vertex normals, edges as fat line
  segments (`LineSegments2`), vertices as points, all in the global frame from `Tessellate`.
- **FreeCAD's look**: the default background gradient (#333365 → #ababc1, Coin's gradient,
  mixed in sRGB), FreeCAD 1.x's three light sources in camera space (headlight 90 %, backlight
  60 %, fill light 40 % #E6FAFF; `View3DSettings.h`), shape #cccccc, lines black 2 px, points
  #191919 (`ViewParams.cpp`), preselection #e1e114, selection #1cad1c.
- **Sub-element picking**: faces by ray casting (triangle → `Face{i+1}` by binary search over the
  per-face ranges), edges and vertices in screen space within FreeCAD's 5 px pick radius, with a
  depth test against the picked face; vertices win over edges over faces. Preselection updates on
  hover (and after camera moves); the status bar prints FreeCAD's
  `Preselected: Unnamed.Box.Face2 (x mm, y mm, z mm)`.
- **Highlighting**: a sub-element gets an overlay (the face's triangle range of the shared
  geometry, the edge's polyline, the vertex); a whole object is recoloured, as Coin does.
- **Navigation**: the navigation styles' drag bindings (`viewer/navigation.ts`), zoom at cursor,
  trackball rotation about the view centre, standard views with FreeCAD's camera quaternions
  (`Camera.cpp`), animated; orthographic (default) or perspective; fit all / fit selection like
  Coin's `viewAll` (bounding sphere).
- **Navigation cube** (`viewer/naviCube.ts`): chamfered cube with 6 faces, 12 edges, 8 corners —
  all clickable — in the top-right corner, FreeCAD Light's colours, 45° arrows around it; the
  corner axis cross bottom-right; `Std_AxisCross` at the origin.
- **Draw styles**: As Is (per object Display Mode), Points, Wireframe, Hidden Line, No Shading,
  Shaded, Flat Lines.
- **Edit mode**: an `EditLayer` (the Sketcher) draws into the scene and gets the pointer first.

## Tree and property view

- `tree/buildTree.ts`: roots are objects no one claims; children are `children` from
  `GetObjects`, with the view providers' rules the server's App layer does not report: an
  `App::Origin` claims its axes and planes; an object claimed by several parents sits under the
  most specific one (a sketch under its Pad, not beside it in the Body). Rows show the visibility
  eye, the type's tree icon (`ui/icons.ts`, after each view provider's `sPixmap`) with
  error/recompute overlays, greyed labels for hidden objects, the active body in bold.
- `properties/model.ts`: FreeCAD property type → editor kind, the value column's text
  (`PropertyItem::toString` per type), parsing (`10`, `10 mm`, `1 in`, `2 ft 3 in`, `90 °`),
  placement/vector sub-rows (Angle, Axis, Position), grouping (`PropertyModel::getGroupInfo`:
  empty group = Base, sorted), the echo line. Read-only properties are greyed; `=` turns any editor
  into an expression; the row tooltip shows the expression.

## Tasks

Task dialogs (`tasks/`) open in the Tasks tab with OK / Cancel. Feature dialogs follow
`TaskFeatureParameters`: the command opens a transaction and creates the feature, the dialog edits
it with a live recompute, OK commits, Cancel aborts. Part: Primitives (all 16 types with
placement), Boolean, Fillet/Chamfer edges, Extrude, Revolve, Mirror. Part Design: sketch plane,
Pad, Pocket, Revolution, Groove, Fillet, Chamfer, Mirrored, Linear/Polar Pattern; double-click on a
feature edits it.

## Sketcher (MVP)

`Sketcher_NewSketch` / `PartDesign_NewSketch` create a sketch on XY/XZ/YZ (FreeCAD's orientation
quaternions, offset, reverse) or on a selected planar face, then enter edit mode: the camera looks
at the sketch plane, a grid and the sketch axes are drawn, other objects are dimmed. Tools: point,
line, polyline, rectangle (FreeCAD's 4 lines + 4 coincident + 2 horizontal + 2 vertical), circle,
arc; clicks snap to existing points (a coincident constraint) and near-horizontal/vertical lines
snap (a horizontal/vertical constraint). Constraints on the selection: coincident / point on
object, horizontal, vertical, parallel, perpendicular, tangent, equal, distance, distance X/Y,
radius, diameter, lock, block; double-click a dimension to change it. The task panel shows the
solver message (DoF), constraints and elements. Esc ends a tool, then leaves the sketch; leaving
recomputes. Everything runs on `ActiveSketch` through `RunPython`, one transaction per operation.

## Icons and texts

`bun run icons:sync` (`tooling/icons/sync.ts`) re-reads the FreeCAD tree (`--freecad <dir>`,
default `../freecad`), writes the command metadata and copies the SVGs the app references into
`public/icons/` with `manifest.json` and `NOTICE` (FreeCAD's LGPL-2.0-or-later; some SVGs carry
CC BY-SA metadata, listed per file). `--check` fails when the committed copies are stale.

## Tests

```sh
bun run test:unit -- --filter web             # bun + happy-dom
bun run test:e2e                               # Playwright smoke suite, ?mock=1
FREECAD_API_SERVER=…/FreeCADApiServer bun run test:e2e:real
FREECAD_API_SERVER=…/FreeCADApiServer SCREENSHOTS=1 bun run --filter @fab-cad/e2e test:real -g screenshot
```

The unit tests cover the property model and the property view (rendered against the mock), tree
building, picking and navigation maps, the Sketcher's Python and vertex numbering, command
metadata, enabling and accelerators, the workbench layouts, backend selection, and the stores and
actions against the in-page mock. The real-server suite creates a box and edits it through the
property view (the mesh follows, undo restores it), cuts two primitives, sketches a rectangle and
pads it in Part Design, exports STEP, and opens/saves an .FCStd. Screenshots in
[`screenshots/`](screenshots/) come from that suite against the real server.

## Known gaps

- **View provider state is page-local.** Colours, display modes, line widths and transparency live
  in the page (the API server has no GUI document): they are lost on reload, are not read from an
  opened file's `GuiDocument.xml` and are not written when saving. Visibility is the exception (an
  App property).
- **Tree claims.** The server reports App-level `children`; view-provider claims are reproduced
  for origins and multi-parent features only (see `tree/buildTree.ts`).
- **Sketcher** is an MVP: no trimming, fillets, B-splines, external geometry, construction-mode
  drawing, box selection or dragging of geometry; arcs are centre–start–end counter-clockwise;
  constraint icons are badges, not FreeCAD's on-geometry glyphs.
- **Part Design**: no face picking for "Up to face", no Hole, Loft, Pipe, Helix, Draft,
  Thickness, MultiTransform; patterns start on the body's origin axes/planes (change them in the
  property view).
- **3D view**: no box selection, clipping, stereo, per-face colours or textures; rotation is
  around the view centre (FreeCAD can use the point under the cursor).
- **Files**: no recent-files list, merge, revert or print; the `.FCStd` produced in the browser is
  FreeCAD's `SaveDocumentBytes`, without a GUI part.
- **Python**: the console, the Sketcher and Part Design use `RunPython`; a server started with
  `--no-python` (or a wasm build without Python) supports the Part workbench, the property view,
  files and undo only.

## What the API could add

| Wish                                                                                                                                     | Why                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| View properties: `GetViewProperties` / `SetViewProperties`, and `GuiDocument.xml` kept through `OpenDocumentBytes` / `SaveDocumentBytes` | colours and display modes survive a round trip through the web UI; files from the desktop open with their colours                   |
| `fileName` empty (or a flag) for documents opened from bytes                                                                             | today it is a server temp path (`/tmp/fcapi-upload-*`), which the UI has to recognise so Save downloads instead of writing there    |
| Tree children as the view providers claim them                                                                                           | Origins, Part booleans and Part Design bodies nest differently in FreeCAD's GUI than their App `children` say                       |
| Sketch commands (`GetSketch`, `AddGeometry`, `AddConstraint`, `SetDatum`, `Solve`)                                                       | the Sketcher works without `RunPython` (wasm builds, `--no-python`) and without parsing Python output                               |
| Transactions for `RunPython`                                                                                                             | Python changes outside an explicit `OpenTransaction` are not undoable; FreeCAD's GUI wraps console commands in its own transactions |
| Events for `touch()` / state-only changes, and per-object `Recompute`                                                                    | `Std_MarkToRecompute` has to reload the model to see the touched state                                                              |
| Undo stack names in `DocumentInfo` or the `Undo`/`Redo`/`TransactionCommitted` events                                                    | one request less after every edit                                                                                                   |
| Unit schema and decimals (`GetPreferences`)                                                                                              | the UI formats quantities itself (Standard schema, 2 decimals)                                                                      |
| Per-face colours and edge-to-face adjacency in `Tessellate`                                                                              | `DiffuseColor` / `ShapeAppearance`, and a face's edges for fillet dialogs                                                           |

## Command coverage

Generated by `bun --preload ./test/setup.ts scripts/coverage.ts` in `apps/web`: every command of
FreeCAD's menus and toolbars in the three workbenches. "Partial" says what differs; "not yet"
commands are in the menus, disabled.

<!-- coverage:start -->

**321 commands**: 108 implemented, 59 partial, 154 not yet (shown in the menus, disabled).

#### File menu

| Command                 | FreeCAD menu text    | Status      | Notes                                                                                         |
| ----------------------- | -------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `Std_New`               | New Document         | implemented |                                                                                               |
| `Std_Open`              | Open…                | partial     | file picker (.FCStd opened, STEP/IGES/BREP/STL imported into a new document); no recent files |
| `Std_RecentFiles`       | Open Recent          | not yet     |                                                                                               |
| `Std_CloseActiveWindow` | Close                | implemented |                                                                                               |
| `Std_CloseAllWindows`   | Close All            | implemented |                                                                                               |
| `Std_Save`              | Save                 | partial     | saves on the server when the document has a server path, else downloads the .FCStd            |
| `Std_SaveAs`            | Save As…             | partial     | server path (native backends) or download                                                     |
| `Std_SaveCopy`          | Save a Copy…         | partial     | download                                                                                      |
| `Std_SaveAll`           | Save All             | implemented |                                                                                               |
| `Std_Revert`            | Revert               | not yet     |                                                                                               |
| `Std_Import`            | Import…              | partial     | STEP, IGES, BREP, STL, OBJ through Import with bytes                                          |
| `Std_Export`            | Export…              | partial     | STEP, IGES, BREP, STL, OBJ through Export, downloaded                                         |
| `Std_MergeProjects`     | Merge Document       | not yet     |                                                                                               |
| `Std_ProjectInfo`       | Document Information | partial     | read-only summary                                                                             |
| `Std_Print`             | Print                | not yet     |                                                                                               |
| `Std_PrintPreview`      | Print Preview        | not yet     |                                                                                               |
| `Std_PrintPdf`          | Export PDF           | not yet     |                                                                                               |
| `Std_Quit`              | Exit                 | not yet     |                                                                                               |

#### Edit menu

| Command                         | FreeCAD menu text      | Status      | Notes                                 |
| ------------------------------- | ---------------------- | ----------- | ------------------------------------- |
| `Std_Undo`                      | Undo                   | implemented |                                       |
| `Std_Redo`                      | Redo                   | implemented |                                       |
| `Std_Cut`                       | Cut                    | not yet     |                                       |
| `Std_Copy`                      | Copy                   | not yet     |                                       |
| `Std_Paste`                     | Paste                  | not yet     |                                       |
| `PartDesign_DuplicateSelection` | Duplicate Object       | partial     | Document.copyObject through RunPython |
| `Std_Delete`                    | Delete                 | implemented |                                       |
| `Std_Refresh`                   | Recompute              | implemented |                                       |
| `Std_BoxSelection`              | Box Selection          | not yet     |                                       |
| `Std_BoxElementSelection`       | Box Element Selection  | not yet     |                                       |
| `Std_SelectAll`                 | Select All             | implemented |                                       |
| `Std_TransformManip`            | Transform              | not yet     |                                       |
| `Std_Placement`                 | Placement              | not yet     |                                       |
| `Std_Alignment`                 | Align To…              | not yet     |                                       |
| `Std_SendToPythonConsole`       | Send to Python Console | partial     | defines obj / shp / elt on the server |
| `Std_Properties`                | Properties             | implemented |                                       |
| `Std_Edit`                      | Toggle Edit Mode       | partial     | sketches and Part Design features     |
| `Std_UserEditMode`              | Edit Mode              | not yet     |                                       |
| `Std_DlgPreferences`            | Preferences            | not yet     |                                       |
| `Std_Part`                      | New Part               | implemented |                                       |
| `Std_Group`                     | New Group              | implemented |                                       |
| `Std_VarSet`                    | Variable Set           | implemented |                                       |
| `Std_AnnotationLabel`           | Annotation Label       | not yet     |                                       |
| `Part_Datums`                   | Datums                 | not yet     |                                       |
| `Std_LinkActions`               | Link Actions           | not yet     |                                       |
| `Std_TextDocument`              | Text Document          | not yet     |                                       |

#### View menu

| Command                        | FreeCAD menu text           | Status      | Notes                                                            |
| ------------------------------ | --------------------------- | ----------- | ---------------------------------------------------------------- |
| `Std_ViewCreate`               | New 3D View                 | not yet     |                                                                  |
| `Std_OrthographicCamera`       | Orthographic View           | implemented |                                                                  |
| `Std_PerspectiveCamera`        | Perspective View            | implemented |                                                                  |
| `Std_MainFullscreen`           | Fullscreen                  | not yet     |                                                                  |
| `Std_ViewFitAll`               | Fit All                     | implemented |                                                                  |
| `Std_ViewFitSelection`         | Fit Selection               | implemented |                                                                  |
| `Std_AlignToSelection`         | Align to Selection          | partial     | planar faces                                                     |
| `Std_ViewIsometric`            | Isometric                   | implemented |                                                                  |
| `Std_ViewDimetric`             | Dimetric                    | implemented |                                                                  |
| `Std_ViewTrimetric`            | Trimetric                   | implemented |                                                                  |
| `Std_ViewHome`                 | Home                        | implemented |                                                                  |
| `Std_ViewFront`                | Front                       | implemented |                                                                  |
| `Std_ViewTop`                  | Top                         | implemented |                                                                  |
| `Std_ViewRight`                | Right                       | implemented |                                                                  |
| `Std_ViewRear`                 | Rear                        | implemented |                                                                  |
| `Std_ViewBottom`               | Bottom                      | implemented |                                                                  |
| `Std_ViewLeft`                 | Left                        | implemented |                                                                  |
| `Std_ViewRotateLeft`           | Rotate Left                 | implemented |                                                                  |
| `Std_ViewRotateRight`          | Rotates Right               | implemented |                                                                  |
| `Std_StoreWorkingView`         | Store Working View          | not yet     |                                                                  |
| `Std_RecallWorkingView`        | Recall Working View         | not yet     |                                                                  |
| `Std_FreezeViews`              | Freeze Display              | not yet     |                                                                  |
| `Std_DrawStyle`                | Draw Style                  | implemented |                                                                  |
| `Std_SelBoundingBox`           | Bounding Box                | not yet     |                                                                  |
| `Std_ViewZoomIn`               | Zoom In                     | implemented |                                                                  |
| `Std_ViewZoomOut`              | Zoom Out                    | implemented |                                                                  |
| `Std_ViewBoxZoom`              | Box Zoom                    | not yet     |                                                                  |
| `Std_ViewDockUndockFullscreen` | Document Window             | not yet     |                                                                  |
| `Std_ViewIvIssueCamPos`        | Issue Camera Position       | not yet     |                                                                  |
| `Std_AxisCross`                | Toggle Axis Cross           | implemented |                                                                  |
| `Std_ToggleClipPlane`          | Clipping View               | not yet     |                                                                  |
| `Std_TextureMapping`           | Texture Mapping             | not yet     |                                                                  |
| `Std_ToggleVisibility`         | Toggle Visibility           | implemented |                                                                  |
| `Std_ShowSelection`            | Show Selection              | implemented |                                                                  |
| `Std_HideSelection`            | Hide Selection              | implemented |                                                                  |
| `Std_SelectVisibleObjects`     | Select Visible Objects      | implemented |                                                                  |
| `Std_ToggleObjects`            | Toggle All Objects          | implemented |                                                                  |
| `Std_ShowObjects`              | Show All Objects            | implemented |                                                                  |
| `Std_HideObjects`              | Hide All Objects            | implemented |                                                                  |
| `Std_ToggleSelectability`      | Toggle Selectability        | partial     | view properties live in the page                                 |
| `Std_ToggleNavigation`         | Toggle Navigation/Edit Mode | not yet     |                                                                  |
| `Std_RandomColor`              | Random Color                | partial     | view properties live in the page (no GUI document on the server) |
| `Part_ColorPerFace`            | Appearance per Face         | not yet     |                                                                  |
| `Std_ToggleTransparency`       | Toggle Transparency         | partial     | view properties live in the page                                 |
| `Std_Workbench`                | Workbench                   | implemented |                                                                  |
| `Std_ToolBarMenu`              | Toolbars                    | not yet     |                                                                  |
| `Std_ComboView`                | Combo View                  | implemented |                                                                  |
| `Std_ReportView`               | Report view                 | implemented |                                                                  |
| `Std_PythonView`               | Python console              | implemented |                                                                  |
| `Std_ToggleBottomPanels`       | Toggle Bottom Panels        | implemented |                                                                  |
| `Std_LinkSelectActions`        | Link Navigation             | not yet     |                                                                  |
| `Std_TreeViewActions`          | Tree View Actions           | not yet     |                                                                  |
| `Std_ViewStatusBar`            | Status Bar                  | implemented |                                                                  |

#### Tools menu

| Command                     | FreeCAD menu text        | Status  | Notes                          |
| --------------------------- | ------------------------ | ------- | ------------------------------ |
| `Std_Measure`               | Measure                  | not yet |                                |
| `Std_MassProperties`        | Mass Properties          | not yet |                                |
| `Std_UnitsCalculator`       | Units Converter          | not yet |                                |
| `Std_ClarifySelection`      | Clarify Selection        | not yet |                                |
| `Std_ViewLoadImage`         | Load Image…              | not yet |                                |
| `Std_ViewScreenShot`        | Save Image…              | partial | PNG of the 3D view, downloaded |
| `Std_DemoMode`              | View Turntable           | not yet |                                |
| `Std_SceneInspector`        | Scene Inspector          | not yet |                                |
| `Std_DependencyGraph`       | Dependency Graph         | not yet |                                |
| `Std_ExportDependencyGraph` | Export Dependency Graph… | not yet |                                |
| `Std_ProjectUtil`           | Document Utility         | not yet |                                |
| `Std_DlgParameter`          | Edit Parameters          | not yet |                                |
| `Std_DlgCustomize`          | Customize                | not yet |                                |

#### Macro menu

| Command                     | FreeCAD menu text         | Status  | Notes |
| --------------------------- | ------------------------- | ------- | ----- |
| `Std_DlgMacroRecord`        | Record Macro              | not yet |       |
| `Std_DlgMacroExecute`       | Macros                    | not yet |       |
| `Std_RecentMacros`          | Recent Macros             | not yet |       |
| `Std_DlgMacroExecuteDirect` | Execute Macro             | not yet |       |
| `Std_MacroAttachDebugger`   | Attach to Remote Debugger | not yet |       |

#### Windows menu

| Command                  | FreeCAD menu text  | Status      | Notes                  |
| ------------------------ | ------------------ | ----------- | ---------------------- |
| `Std_ActivateNextWindow` | Next               | implemented |                        |
| `Std_ActivatePrevWindow` | Previous           | implemented |                        |
| `Std_TileWindows`        | Tile               | not yet     |                        |
| `Std_CascadeWindows`     | Cascade            | not yet     |                        |
| `Std_Windows`            | Choose Open Window | partial     | picks a window by name |

#### Help menu

| Command                 | FreeCAD menu text            | Status      | Notes |
| ----------------------- | ---------------------------- | ----------- | ----- |
| `Std_WhatsThis`         | What's This?                 | not yet     |       |
| `Std_Start`             | Start Page                   | implemented |       |
| `Std_FreeCADUserHub`    | User Documentation           | implemented |       |
| `Std_FreeCADForum`      | FreeCAD Forum                | implemented |       |
| `Std_ReportBug`         | Report an Issue              | implemented |       |
| `Std_RestartInSafeMode` | Restart in Safe Mode         | not yet     |       |
| `Std_DevHandbook`       | Developers Handbook          | implemented |       |
| `Std_PythonHelp`        | Python Modules Documentation | implemented |       |
| `Std_FreeCADWebsite`    | FreeCAD Website              | implemented |       |
| `Std_FreeCADDonation`   | Donate to FreeCAD            | implemented |       |
| `Std_About`             | About %1                     | implemented |       |

#### View toolbar

| Command         | FreeCAD menu text | Status      | Notes |
| --------------- | ----------------- | ----------- | ----- |
| `Std_ViewGroup` | Standard Views    | implemented |       |

#### Part workbench

| Command                       | FreeCAD menu text      | Status      | Notes                                                             |
| ----------------------------- | ---------------------- | ----------- | ----------------------------------------------------------------- |
| `Part_BoxSelection`           | Box Selection          | not yet     |                                                                   |
| `Part_Box`                    | Cube                   | implemented |                                                                   |
| `Part_Cylinder`               | Cylinder               | implemented |                                                                   |
| `Part_Sphere`                 | Sphere                 | implemented |                                                                   |
| `Part_Cone`                   | Cone                   | implemented |                                                                   |
| `Part_Torus`                  | Torus                  | implemented |                                                                   |
| `Part_Tube`                   | Tube                   | partial     | creates the Python feature; no task dialog                        |
| `Part_Primitives`             | Primitive              | partial     | all primitive types and placement; no edit of existing primitives |
| `Part_Builder`                | Shape Builder          | not yet     |                                                                   |
| `Part_ShapeFromMesh`          | Shape From Mesh        | not yet     |                                                                   |
| `Part_PointsFromMesh`         | Points From Shape      | not yet     |                                                                   |
| `Part_MakeSolid`              | Convert to Solid       | not yet     |                                                                   |
| `Part_ReverseShape`           | Reverse Shapes         | not yet     |                                                                   |
| `Part_SimpleCopy`             | Simple Copy            | not yet     |                                                                   |
| `Part_TransformedCopy`        | Transformed Copy       | not yet     |                                                                   |
| `Part_ElementCopy`            | Shape Element Copy     | not yet     |                                                                   |
| `Part_RefineShape`            | Refine Shape           | implemented |                                                                   |
| `Part_Boolean`                | Boolean Operation      | implemented |                                                                   |
| `Part_Cut`                    | Cut                    | implemented |                                                                   |
| `Part_Fuse`                   | Union                  | implemented |                                                                   |
| `Part_Common`                 | Intersection           | implemented |                                                                   |
| `Part_JoinConnect`            | Connect Shapes         | not yet     |                                                                   |
| `Part_JoinEmbed`              | Embed Shapes           | not yet     |                                                                   |
| `Part_JoinCutout`             | Cutout Shape           | not yet     |                                                                   |
| `Part_BooleanFragments`       | Boolean Fragments      | not yet     |                                                                   |
| `Part_SliceApart`             | Slice Apart            | not yet     |                                                                   |
| `Part_Slice`                  | Slice to Compound      | not yet     |                                                                   |
| `Part_XOR`                    | Boolean XOR            | not yet     |                                                                   |
| `Part_Compound`               | Compound               | implemented |                                                                   |
| `Part_ExplodeCompound`        | Explode Compound       | not yet     |                                                                   |
| `Part_CompoundFilter`         | Compound Filter        | not yet     |                                                                   |
| `Part_ToleranceSet`           | Set Tolerance          | not yet     |                                                                   |
| `Sketcher_NewSketch`          | New Sketch             | partial     | XY / XZ / YZ with offset and reverse, or a selected planar face   |
| `Part_Extrude`                | Extrude                | partial     | normal / custom direction, lengths, symmetric, solid, taper       |
| `Part_Revolve`                | Revolve                | partial     | Y axis through the origin, angle, solid                           |
| `Part_Mirror`                 | Mirror                 | partial     | YZ / XZ / XY planes through the origin                            |
| `Part_Scale`                  | Scale                  | not yet     |                                                                   |
| `Part_Fillet`                 | Fillet                 | partial     | one radius for the chosen edges                                   |
| `Part_Chamfer`                | Chamfer                | partial     | one size for the chosen edges                                     |
| `Part_MakeFace`               | Face From Wires        | not yet     |                                                                   |
| `Part_RuledSurface`           | Ruled Surface          | not yet     |                                                                   |
| `Part_Loft`                   | Loft                   | not yet     |                                                                   |
| `Part_Sweep`                  | Sweep                  | not yet     |                                                                   |
| `Part_Section`                | Section                | implemented |                                                                   |
| `Part_CrossSections`          | Cross-Sections         | not yet     |                                                                   |
| `Part_Offset`                 | 3D Offset              | not yet     |                                                                   |
| `Part_Offset2D`               | 2D Offset              | not yet     |                                                                   |
| `Part_Thickness`              | Thickness              | not yet     |                                                                   |
| `Part_ProjectionOnSurface`    | Project on Surface     | not yet     |                                                                   |
| `Part_SectionCut`             | Persistent Section Cut | not yet     |                                                                   |
| `Part_EditAttachment`         | Attachment             | not yet     |                                                                   |
| `Part_CheckGeometry`          | Check Geometry         | not yet     |                                                                   |
| `Part_Defeaturing`            | Defeaturing            | not yet     |                                                                   |
| `Materials_InspectAppearance` | Inspect Appearance     | not yet     |                                                                   |
| `Materials_InspectMaterial`   | Inspect Material       | not yet     |                                                                   |
| `Part_Box`                    | Cube                   | implemented |                                                                   |
| `Part_Cylinder`               | Cylinder               | implemented |                                                                   |
| `Part_Sphere`                 | Sphere                 | implemented |                                                                   |
| `Part_Cone`                   | Cone                   | implemented |                                                                   |
| `Part_Torus`                  | Torus                  | implemented |                                                                   |
| `Part_Tube`                   | Tube                   | partial     | creates the Python feature; no task dialog                        |
| `Part_Primitives`             | Primitive              | partial     | all primitive types and placement; no edit of existing primitives |
| `Part_Builder`                | Shape Builder          | not yet     |                                                                   |
| `Sketcher_NewSketch`          | New Sketch             | partial     | XY / XZ / YZ with offset and reverse, or a selected planar face   |
| `Part_Extrude`                | Extrude                | partial     | normal / custom direction, lengths, symmetric, solid, taper       |
| `Part_Revolve`                | Revolve                | partial     | Y axis through the origin, angle, solid                           |
| `Part_Mirror`                 | Mirror                 | partial     | YZ / XZ / XY planes through the origin                            |
| `Part_Scale`                  | Scale                  | not yet     |                                                                   |
| `Part_Fillet`                 | Fillet                 | partial     | one radius for the chosen edges                                   |
| `Part_Chamfer`                | Chamfer                | partial     | one size for the chosen edges                                     |
| `Part_MakeFace`               | Face From Wires        | not yet     |                                                                   |
| `Part_RuledSurface`           | Ruled Surface          | not yet     |                                                                   |
| `Part_Loft`                   | Loft                   | not yet     |                                                                   |
| `Part_Sweep`                  | Sweep                  | not yet     |                                                                   |
| `Part_Section`                | Section                | implemented |                                                                   |
| `Part_CrossSections`          | Cross-Sections         | not yet     |                                                                   |
| `Part_CompOffset`             | Offset                 | not yet     |                                                                   |
| `Part_Thickness`              | Thickness              | not yet     |                                                                   |
| `Part_ProjectionOnSurface`    | Project on Surface     | not yet     |                                                                   |
| `Part_CompCompoundTools`      | Compound Tools         | partial     |                                                                   |
| `Part_Boolean`                | Boolean Operation      | implemented |                                                                   |
| `Part_Cut`                    | Cut                    | implemented |                                                                   |
| `Part_Fuse`                   | Union                  | implemented |                                                                   |
| `Part_Common`                 | Intersection           | implemented |                                                                   |
| `Part_CompJoinFeatures`       | Join Shapes            | not yet     |                                                                   |
| `Part_CompSplitFeatures`      | Split Shapes           | not yet     |                                                                   |
| `Part_CheckGeometry`          | Check Geometry         | not yet     |                                                                   |
| `Part_Defeaturing`            | Defeaturing            | not yet     |                                                                   |

#### Part Design workbench

| Command                               | FreeCAD menu text     | Status      | Notes                                                                         |
| ------------------------------------- | --------------------- | ----------- | ----------------------------------------------------------------------------- |
| `PartDesign_NewSketch`                | New Sketch            | partial     | on a base plane or a selected planar face                                     |
| `Sketcher_EditSketch`                 | Edit Sketch           | implemented |                                                                               |
| `Sketcher_MapSketch`                  | Attach Sketch         | not yet     |                                                                               |
| `Sketcher_ReorientSketch`             | Reorient Sketch       | not yet     |                                                                               |
| `Sketcher_ValidateSketch`             | Validate Sketch       | not yet     |                                                                               |
| `Sketcher_MergeSketches`              | Merge Sketches        | not yet     |                                                                               |
| `Sketcher_MirrorSketch`               | Mirror Sketch         | not yet     |                                                                               |
| `PartDesign_Body`                     | New Body              | implemented |                                                                               |
| `PartDesign_ShapeBinder`              | Shape Binder          | not yet     |                                                                               |
| `PartDesign_SubShapeBinder`           | Sub-Shape Binder      | not yet     |                                                                               |
| `PartDesign_Clone`                    | Clone                 | not yet     |                                                                               |
| `PartDesign_Pad`                      | Pad                   | partial     | type, length, side, reversed, taper, refine; no face picking for 'up to face' |
| `PartDesign_Revolution`               | Revolve               | partial     | sketch V axis; angle, side, reversed                                          |
| `PartDesign_AdditiveLoft`             | Additive Loft         | not yet     |                                                                               |
| `PartDesign_AdditivePipe`             | Additive Pipe         | not yet     |                                                                               |
| `PartDesign_AdditiveHelix`            | Additive Helix        | not yet     |                                                                               |
| `PartDesign_CompPrimitiveAdditive`    | Additive Primitive    | implemented |                                                                               |
| `PartDesign_Pocket`                   | Pocket                | partial     | as Pad                                                                        |
| `PartDesign_Hole`                     | Hole                  | not yet     |                                                                               |
| `PartDesign_Groove`                   | Groove                | partial     | sketch V axis; angle, side, reversed                                          |
| `PartDesign_SubtractiveLoft`          | Subtractive Loft      | not yet     |                                                                               |
| `PartDesign_SubtractivePipe`          | Subtractive Pipe      | not yet     |                                                                               |
| `PartDesign_SubtractiveHelix`         | Subtractive Helix     | not yet     |                                                                               |
| `PartDesign_CompPrimitiveSubtractive` | Subtractive Primitive | implemented |                                                                               |
| `PartDesign_Fillet`                   | Fillet                | partial     | selected edges/faces, radius                                                  |
| `PartDesign_Chamfer`                  | Chamfer               | partial     | selected edges/faces, size / type                                             |
| `PartDesign_Draft`                    | Draft                 | not yet     |                                                                               |
| `PartDesign_Thickness`                | Thickness             | not yet     |                                                                               |
| `PartDesign_Defeaturing`              | Defeaturing           | not yet     |                                                                               |
| `PartDesign_Mirrored`                 | Mirror                | partial     | body YZ plane; plane choice in the property view                              |
| `PartDesign_LinearPattern`            | Linear Pattern        | partial     | body X axis; length, occurrences                                              |
| `PartDesign_PolarPattern`             | Polar Pattern         | partial     | body Z axis; angle, occurrences                                               |
| `PartDesign_MultiTransform`           | Multi-Transform       | not yet     |                                                                               |
| `PartDesign_Boolean`                  | Boolean Operation     | not yet     |                                                                               |
| `PartDesign_InvoluteGear`             | Involute Gear         | not yet     |                                                                               |
| `PartDesign_Sprocket`                 | Sprocket              | not yet     |                                                                               |
| `PartDesign_Body`                     | New Body              | implemented |                                                                               |
| `PartDesign_CompSketches`             | Create Datum          | partial     |                                                                               |
| `Sketcher_ValidateSketch`             | Validate Sketch       | not yet     |                                                                               |
| `PartDesign_SubShapeBinder`           | Sub-Shape Binder      | not yet     |                                                                               |
| `PartDesign_Clone`                    | Clone                 | not yet     |                                                                               |
| `PartDesign_Pad`                      | Pad                   | partial     | type, length, side, reversed, taper, refine; no face picking for 'up to face' |
| `PartDesign_Revolution`               | Revolve               | partial     | sketch V axis; angle, side, reversed                                          |
| `PartDesign_AdditiveLoft`             | Additive Loft         | not yet     |                                                                               |
| `PartDesign_AdditivePipe`             | Additive Pipe         | not yet     |                                                                               |
| `PartDesign_AdditiveHelix`            | Additive Helix        | not yet     |                                                                               |
| `PartDesign_CompPrimitiveAdditive`    | Additive Primitive    | implemented |                                                                               |
| `PartDesign_Pocket`                   | Pocket                | partial     | as Pad                                                                        |
| `PartDesign_Hole`                     | Hole                  | not yet     |                                                                               |
| `PartDesign_Groove`                   | Groove                | partial     | sketch V axis; angle, side, reversed                                          |
| `PartDesign_SubtractiveLoft`          | Subtractive Loft      | not yet     |                                                                               |
| `PartDesign_SubtractivePipe`          | Subtractive Pipe      | not yet     |                                                                               |
| `PartDesign_SubtractiveHelix`         | Subtractive Helix     | not yet     |                                                                               |
| `PartDesign_CompPrimitiveSubtractive` | Subtractive Primitive | implemented |                                                                               |
| `PartDesign_Boolean`                  | Boolean Operation     | not yet     |                                                                               |
| `PartDesign_Fillet`                   | Fillet                | partial     | selected edges/faces, radius                                                  |
| `PartDesign_Chamfer`                  | Chamfer               | partial     | selected edges/faces, size / type                                             |
| `PartDesign_Draft`                    | Draft                 | not yet     |                                                                               |
| `PartDesign_Thickness`                | Thickness             | not yet     |                                                                               |
| `PartDesign_Defeaturing`              | Defeaturing           | not yet     |                                                                               |
| `PartDesign_Mirrored`                 | Mirror                | partial     | body YZ plane; plane choice in the property view                              |
| `PartDesign_LinearPattern`            | Linear Pattern        | partial     | body X axis; length, occurrences                                              |
| `PartDesign_PolarPattern`             | Polar Pattern         | partial     | body Z axis; angle, occurrences                                               |
| `PartDesign_MultiTransform`           | Multi-Transform       | not yet     |                                                                               |

#### Sketcher workbench

| Command                               | FreeCAD menu text                    | Status      | Notes                                                      |
| ------------------------------------- | ------------------------------------ | ----------- | ---------------------------------------------------------- |
| `Sketcher_LeaveSketch`                | Leave Sketch                         | implemented |                                                            |
| `Sketcher_CancelSketch`               | Cancel Editing                       | partial     | leaves without recomputing (edits already committed)       |
| `Sketcher_ViewSketch`                 | Align View to Sketch                 | implemented |                                                            |
| `Sketcher_ViewSection`                | Toggle Section View                  | not yet     |                                                            |
| `Sketcher_StopOperation`              | Stop Operation                       | implemented |                                                            |
| `Sketcher_CreatePoint`                | Point                                | implemented |                                                            |
| `Sketcher_CreatePolyline`             | Polyline                             | partial     | line segments only (no arc mode)                           |
| `Sketcher_CreateLine`                 | Line                                 | implemented |                                                            |
| `Sketcher_CreateArc`                  | Arc From Center                      | partial     | centre, start, end (counter-clockwise)                     |
| `Sketcher_Create3PointArc`            | Arc From 3 Points                    | not yet     |                                                            |
| `Sketcher_CreateCircle`               | Circle From Center                   | implemented |                                                            |
| `Sketcher_Create3PointCircle`         | Circle From 3 Points                 | not yet     |                                                            |
| `Sketcher_CreateRectangle`            | Rectangle                            | implemented |                                                            |
| `Sketcher_CreateRectangle_Center`     | Centered Rectangle                   | not yet     |                                                            |
| `Sketcher_CreateOblong`               | Rounded Rectangle                    | not yet     |                                                            |
| `Sketcher_CreateSlot`                 | Slot                                 | not yet     |                                                            |
| `Sketcher_ToggleConstruction`         | Toggle Construction Geometry         | implemented |                                                            |
| `Sketcher_ConstrainCoincidentUnified` | Coincident Constraint                | partial     | point on point, point on edge                              |
| `Sketcher_ConstrainHorVer`            | Horizontal/Vertical Constraint       | implemented |                                                            |
| `Sketcher_ConstrainHorizontal`        | Horizontal Constraint                | implemented |                                                            |
| `Sketcher_ConstrainVertical`          | Vertical Constraint                  | implemented |                                                            |
| `Sketcher_ConstrainParallel`          | Parallel Constraint                  | implemented |                                                            |
| `Sketcher_ConstrainPerpendicular`     | Perpendicular Constraint             | implemented |                                                            |
| `Sketcher_ConstrainTangent`           | Tangent/Collinear Constraint         | implemented |                                                            |
| `Sketcher_ConstrainEqual`             | Equal Constraint                     | implemented |                                                            |
| `Sketcher_ConstrainSymmetric`         | Symmetric Constraint                 | not yet     |                                                            |
| `Sketcher_ConstrainBlock`             | Block Constraint                     | implemented |                                                            |
| `Sketcher_Dimension`                  | Dimension                            | partial     | distance for lines and points, radius for circles and arcs |
| `Sketcher_ConstrainDistanceX`         | Horizontal Dimension                 | implemented |                                                            |
| `Sketcher_ConstrainDistanceY`         | Vertical Dimension                   | implemented |                                                            |
| `Sketcher_ConstrainDistance`          | Distance Dimension                   | partial     | line length or distance between two points                 |
| `Sketcher_ConstrainRadius`            | Radius Dimension                     | implemented |                                                            |
| `Sketcher_ConstrainDiameter`          | Diameter Dimension                   | implemented |                                                            |
| `Sketcher_ConstrainAngle`             | Angle Dimension                      | not yet     |                                                            |
| `Sketcher_ConstrainLock`              | Lock Position                        | implemented |                                                            |
| `Sketcher_ToggleDrivingConstraint`    | Toggle Driving/Reference Constraints | not yet     |                                                            |
| `Sketcher_ToggleActiveConstraint`     | Toggle Constraints                   | not yet     |                                                            |

<!-- coverage:end -->
