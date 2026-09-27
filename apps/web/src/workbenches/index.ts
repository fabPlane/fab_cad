/**
 * Workbench definitions: the menu bar and toolbars each workbench shows, transcribed from
 * `src/Gui/Workbench.cpp` (`StdWorkbench::setupMenuBar/setupToolBars/setupContextMenu`) and the
 * workbenches' `Gui/Workbench.cpp`. Entries are FreeCAD command names; `"Separator"` separates.
 */
import type { WorkbenchId } from "../state/app";

export type MenuEntry = string | { menu: string; items: MenuEntry[] };

export interface Menu {
  title: string;
  items: MenuEntry[];
}

export interface Toolbar {
  name: string;
  items: string[];
  /** Shown only while editing a sketch (`DefaultVisibility::Unavailable` outside edit mode). */
  editModeOnly?: boolean;
  /** Hidden while editing a sketch (the Sketcher swaps toolbars in edit mode). */
  hiddenInEditMode?: boolean;
}

export interface Workbench {
  id: WorkbenchId;
  name: string;
  icon: string;
  menus: Menu[];
  toolbars: Toolbar[];
}

const sub = (menu: string, items: MenuEntry[]): MenuEntry => ({ menu, items });

// ------------------------------------------------------------------------------------ standard

function stdMenus(): Menu[] {
  const create = sub("Create", [
    "Std_Part",
    "Std_Group",
    "Std_VarSet",
    "Std_AnnotationLabel",
    "Part_Datums",
    "Std_LinkActions",
    "Separator",
    "Std_TextDocument",
  ]);
  const axoviews = sub("A&xonometric", ["Std_ViewIsometric", "Std_ViewDimetric", "Std_ViewTrimetric"]);
  const stdviews = sub("Standard &Views", [
    "Std_ViewFitAll",
    "Std_ViewFitSelection",
    "Std_AlignToSelection",
    axoviews,
    "Separator",
    "Std_ViewHome",
    "Std_ViewFront",
    "Std_ViewTop",
    "Std_ViewRight",
    "Std_ViewRear",
    "Std_ViewBottom",
    "Std_ViewLeft",
    "Separator",
    "Std_ViewRotateLeft",
    "Std_ViewRotateRight",
    "Separator",
    "Std_StoreWorkingView",
    "Std_RecallWorkingView",
  ]);
  const zoom = sub("&Zoom", ["Std_ViewZoomIn", "Std_ViewZoomOut", "Separator", "Std_ViewBoxZoom"]);
  const visu = sub("V&isibility", [
    "Std_ToggleVisibility",
    "Std_ShowSelection",
    "Std_HideSelection",
    "Std_SelectVisibleObjects",
    "Separator",
    "Std_ToggleObjects",
    "Std_ShowObjects",
    "Std_HideObjects",
    "Separator",
    "Std_ToggleSelectability",
  ]);
  return [
    {
      title: "&File",
      items: [
        "Std_New",
        "Std_Open",
        "Std_RecentFiles",
        "Separator",
        "Std_CloseActiveWindow",
        "Std_CloseAllWindows",
        "Separator",
        "Std_Save",
        "Std_SaveAs",
        "Std_SaveCopy",
        "Std_SaveAll",
        "Std_Revert",
        "Separator",
        "Std_Import",
        "Std_Export",
        "Std_MergeProjects",
        "Std_ProjectInfo",
        "Separator",
        "Std_Print",
        "Std_PrintPreview",
        "Std_PrintPdf",
        "Separator",
        "Std_Quit",
      ],
    },
    {
      title: "&Edit",
      items: [
        "Std_Undo",
        "Std_Redo",
        "Separator",
        "Std_Cut",
        "Std_Copy",
        "Std_Paste",
        "Std_DuplicateSelection",
        "Std_Delete",
        "Separator",
        "Std_Refresh",
        "Std_BoxSelection",
        "Std_BoxElementSelection",
        "Std_SelectAll",
        "Separator",
        "Std_TransformManip",
        "Std_Placement",
        "Std_Alignment",
        "Std_SendToPythonConsole",
        "Std_Properties",
        "Separator",
        "Std_Edit",
        "Std_UserEditMode",
        "Separator",
        "Std_DlgPreferences",
        create,
      ],
    },
    {
      title: "&View",
      items: [
        "Std_ViewCreate",
        "Std_OrthographicCamera",
        "Std_PerspectiveCamera",
        "Std_MainFullscreen",
        "Separator",
        stdviews,
        "Std_FreezeViews",
        "Std_DrawStyle",
        "Std_SelBoundingBox",
        "Separator",
        zoom,
        "Std_ViewDockUndockFullscreen",
        "Std_ViewIvIssueCamPos",
        "Std_AxisCross",
        "Std_ToggleClipPlane",
        "Std_TextureMapping",
        "Separator",
        visu,
        "Std_ToggleNavigation",
        "Std_RandomColor",
        "Std_ToggleTransparency",
        "Separator",
        "Std_Workbench",
        "Std_ToolBarMenu",
        sub("Panels", ["Std_ComboView", "Std_ReportView", "Std_PythonView"]),
        "Std_ToggleBottomPanels",
        "Separator",
        "Std_LinkSelectActions",
        "Std_TreeViewActions",
        "Std_ViewStatusBar",
      ],
    },
    {
      title: "&Tools",
      items: [
        "Std_AddonMgr",
        "Separator",
        "Std_Measure",
        "Std_MassProperties",
        "Std_UnitsCalculator",
        "Std_ClarifySelection",
        "Separator",
        "Std_ViewLoadImage",
        "Std_ViewScreenShot",
        "Std_DemoMode",
        "Separator",
        "Std_SceneInspector",
        "Std_DependencyGraph",
        "Std_ExportDependencyGraph",
        "Separator",
        "Std_ProjectUtil",
        "Std_DlgParameter",
        "Std_DlgCustomize",
      ],
    },
    {
      title: "&Macro",
      items: [
        "Std_DlgMacroRecord",
        "Std_DlgMacroExecute",
        "Std_RecentMacros",
        "Separator",
        "Std_DlgMacroExecuteDirect",
        "Std_MacroAttachDebugger",
      ],
    },
    {
      title: "&Windows",
      items: [
        "Std_ActivateNextWindow",
        "Std_ActivatePrevWindow",
        "Separator",
        "Std_TileWindows",
        "Std_CascadeWindows",
        "Separator",
        "Std_Windows",
      ],
    },
    {
      title: "&Help",
      items: [
        "Std_WhatsThis",
        "Separator",
        "Std_Start",
        "Separator",
        "Std_FreeCADUserHub",
        "Std_FreeCADForum",
        "Std_ReportBug",
        "Separator",
        "Std_RestartInSafeMode",
        "Separator",
        "Std_DevHandbook",
        "Std_PythonHelp",
        "Separator",
        "Std_FreeCADWebsite",
        "Std_FreeCADDonation",
        "Std_About",
      ],
    },
  ];
}

function stdToolbars(): Toolbar[] {
  return [
    { name: "File", items: ["Std_New", "Std_Open", "Std_Save"] },
    { name: "Edit", items: ["Std_Undo", "Std_Redo", "Separator", "Std_Refresh"] },
    { name: "Workbench", items: ["Std_Workbench"] },
    {
      name: "View",
      items: [
        "Std_ViewFitAll",
        "Std_ViewFitSelection",
        "Std_ViewGroup",
        "Std_AlignToSelection",
        "Separator",
        "Std_DrawStyle",
        "Separator",
        "Std_Measure",
      ],
    },
    { name: "Structure", items: ["Std_Part", "Std_Group", "Std_LinkActions", "Std_VarSet"] },
  ];
}

/** Insert workbench menus before "&Windows" (`root->insertItem(root->findItem("&Windows"), ...)`). */
function withMenus(menus: Menu[], extra: Menu[]): Menu[] {
  const i = menus.findIndex((m) => m.title === "&Windows");
  return [...menus.slice(0, i), ...extra, ...menus.slice(i)];
}

/** `Part_ColorPerFace` after `Std_RandomColor` in the View menu (Part and Part Design). */
function withColorPerFace(menus: Menu[]): Menu[] {
  return menus.map((m) =>
    m.title !== "&View"
      ? m
      : { ...m, items: m.items.flatMap((e) => (e === "Std_RandomColor" ? ["Std_RandomColor", "Part_ColorPerFace"] : [e])) },
  );
}

// ------------------------------------------------------------------------------------ Part

const partPrimitives = ["Part_Box", "Part_Cylinder", "Part_Sphere", "Part_Cone", "Part_Torus", "Part_Tube"];

const PART: Workbench = {
  id: "PartWorkbench",
  name: "Part",
  icon: "PartWorkbench",
  menus: withColorPerFace(
    withMenus(stdMenus(), [
      {
        title: "&Part",
        items: [
          "Part_BoxSelection",
          "Separator",
          sub("Primitives", partPrimitives),
          "Part_Primitives",
          "Part_Builder",
          "Separator",
          "Part_ShapeFromMesh",
          "Part_PointsFromMesh",
          "Part_MakeSolid",
          "Part_ReverseShape",
          sub("Copy", ["Part_SimpleCopy", "Part_TransformedCopy", "Part_ElementCopy", "Part_RefineShape"]),
          "Separator",
          sub("Boolean", ["Part_Boolean", "Part_Cut", "Part_Fuse", "Part_Common"]),
          sub("Join", ["Part_JoinConnect", "Part_JoinEmbed", "Part_JoinCutout"]),
          sub("Split", ["Part_BooleanFragments", "Part_SliceApart", "Part_Slice", "Part_XOR"]),
          sub("Compound", ["Part_Compound", "Part_ExplodeCompound", "Part_CompoundFilter", "Part_ToleranceSet"]),
          "Separator",
          "Sketcher_NewSketch",
          "Part_Extrude",
          "Part_Revolve",
          "Part_Mirror",
          "Part_Scale",
          "Part_Fillet",
          "Part_Chamfer",
          "Part_MakeFace",
          "Part_RuledSurface",
          "Part_Loft",
          "Part_Sweep",
          "Part_Section",
          "Part_CrossSections",
          "Part_Offset",
          "Part_Offset2D",
          "Part_Thickness",
          "Part_ProjectionOnSurface",
          "Part_SectionCut",
          "Separator",
          "Part_EditAttachment",
          "Separator",
          "Part_CheckGeometry",
          "Part_Defeaturing",
          "Materials_InspectAppearance",
          "Materials_InspectMaterial",
        ],
      },
    ]),
  ),
  toolbars: [
    ...stdToolbars(),
    { name: "Solids", items: [...partPrimitives, "Part_Primitives", "Part_Builder"] },
    {
      name: "Part Tools",
      items: [
        "Sketcher_NewSketch",
        "Part_Extrude",
        "Part_Revolve",
        "Part_Mirror",
        "Part_Scale",
        "Part_Fillet",
        "Part_Chamfer",
        "Part_MakeFace",
        "Part_RuledSurface",
        "Part_Loft",
        "Part_Sweep",
        "Part_Section",
        "Part_CrossSections",
        "Part_CompOffset",
        "Part_Thickness",
        "Part_ProjectionOnSurface",
        "Part_ColorPerFace",
      ],
    },
    {
      name: "Boolean Tools",
      items: [
        "Part_CompCompoundTools",
        "Part_Boolean",
        "Part_Cut",
        "Part_Fuse",
        "Part_Common",
        "Part_CompJoinFeatures",
        "Part_CompSplitFeatures",
        "Part_CheckGeometry",
        "Part_Defeaturing",
      ],
    },
  ],
};

// ------------------------------------------------------------------------------------ Part Design

const PARTDESIGN: Workbench = {
  id: "PartDesignWorkbench",
  name: "Part Design",
  icon: "PartDesignWorkbench",
  menus: withColorPerFace(
    withMenus(
      stdMenus().map((m) =>
        m.title === "&Edit"
          ? { ...m, items: m.items.map((e) => (e === "Std_DuplicateSelection" ? "PartDesign_DuplicateSelection" : e)) }
          : m,
      ),
      [
        {
          title: "&Sketch",
          items: [
            "PartDesign_NewSketch",
            "Sketcher_EditSketch",
            "Sketcher_MapSketch",
            "Sketcher_ReorientSketch",
            "Sketcher_ValidateSketch",
            "Sketcher_MergeSketches",
            "Sketcher_MirrorSketch",
          ],
        },
        {
          title: "&Part Design",
          items: [
            "PartDesign_Body",
            "Separator",
            "PartDesign_ShapeBinder",
            "PartDesign_SubShapeBinder",
            "PartDesign_Clone",
            "Separator",
            sub("Additive Features", [
              "PartDesign_Pad",
              "PartDesign_Revolution",
              "PartDesign_AdditiveLoft",
              "PartDesign_AdditivePipe",
              "PartDesign_AdditiveHelix",
            ]),
            "PartDesign_CompPrimitiveAdditive",
            "Separator",
            sub("Subtractive Features", [
              "PartDesign_Pocket",
              "PartDesign_Hole",
              "PartDesign_Groove",
              "PartDesign_SubtractiveLoft",
              "PartDesign_SubtractivePipe",
              "PartDesign_SubtractiveHelix",
            ]),
            "PartDesign_CompPrimitiveSubtractive",
            "Separator",
            sub("Dress-Up Features", [
              "PartDesign_Fillet",
              "PartDesign_Chamfer",
              "PartDesign_Draft",
              "PartDesign_Thickness",
              "PartDesign_Defeaturing",
            ]),
            "Separator",
            sub("Transformation Features", [
              "PartDesign_Mirrored",
              "PartDesign_LinearPattern",
              "PartDesign_PolarPattern",
              "PartDesign_MultiTransform",
            ]),
            "Separator",
            "PartDesign_Boolean",
            "Separator",
            "Materials_InspectAppearance",
            "Materials_InspectMaterial",
            "Separator",
            "Part_CheckGeometry",
            "Separator",
            "PartDesign_InvoluteGear",
            "PartDesign_Sprocket",
          ],
        },
      ],
    ),
  ),
  toolbars: [
    ...stdToolbars(),
    {
      name: "Part Design Helper Features",
      items: [
        "PartDesign_Body",
        "PartDesign_CompSketches",
        "Sketcher_ValidateSketch",
        "Part_CheckGeometry",
        "PartDesign_SubShapeBinder",
        "PartDesign_Clone",
      ],
    },
    {
      name: "Part Design Modeling Features",
      items: [
        "PartDesign_Pad",
        "PartDesign_Revolution",
        "PartDesign_AdditiveLoft",
        "PartDesign_AdditivePipe",
        "PartDesign_AdditiveHelix",
        "PartDesign_CompPrimitiveAdditive",
        "Separator",
        "PartDesign_Pocket",
        "PartDesign_Hole",
        "PartDesign_Groove",
        "PartDesign_SubtractiveLoft",
        "PartDesign_SubtractivePipe",
        "PartDesign_SubtractiveHelix",
        "PartDesign_CompPrimitiveSubtractive",
        "Separator",
        "PartDesign_Boolean",
      ],
    },
    {
      name: "Part Design Dress-Up Features",
      items: ["PartDesign_Fillet", "PartDesign_Chamfer", "PartDesign_Draft", "PartDesign_Thickness", "PartDesign_Defeaturing"],
    },
    {
      name: "Part Design Transformation Features",
      items: ["PartDesign_Mirrored", "PartDesign_LinearPattern", "PartDesign_PolarPattern", "PartDesign_MultiTransform"],
    },
  ],
};

// ------------------------------------------------------------------------------------ Sketcher

const sketchActions = [
  "Sketcher_NewSketch",
  "Sketcher_EditSketch",
  "Sketcher_MapSketch",
  "Sketcher_ReorientSketch",
  "Sketcher_ValidateSketch",
  "Sketcher_MergeSketches",
  "Sketcher_MirrorSketch",
];

export const SKETCHER_EDIT_TOOLBARS: Toolbar[] = [
  { name: "Edit Mode", items: ["Sketcher_LeaveSketch", "Sketcher_ViewSketch", "Sketcher_ViewSection"], editModeOnly: true },
  {
    name: "Geometries",
    items: [
      "Sketcher_CreatePoint",
      "Sketcher_CreatePolyline",
      "Sketcher_CreateLine",
      "Sketcher_CreateArc",
      "Sketcher_CreateCircle",
      "Sketcher_CreateRectangle",
      "Sketcher_CreateSlot",
      "Separator",
      "Sketcher_ToggleConstruction",
    ],
    editModeOnly: true,
  },
  {
    name: "Constraints",
    items: [
      "Sketcher_ConstrainCoincidentUnified",
      "Sketcher_ConstrainHorizontal",
      "Sketcher_ConstrainVertical",
      "Sketcher_ConstrainParallel",
      "Sketcher_ConstrainPerpendicular",
      "Sketcher_ConstrainTangent",
      "Sketcher_ConstrainEqual",
      "Separator",
      "Sketcher_ConstrainDistanceX",
      "Sketcher_ConstrainDistanceY",
      "Sketcher_ConstrainDistance",
      "Sketcher_ConstrainRadius",
      "Sketcher_ConstrainDiameter",
      "Sketcher_ConstrainLock",
    ],
    editModeOnly: true,
  },
];

const SKETCHER: Workbench = {
  id: "SketcherWorkbench",
  name: "Sketcher",
  icon: "SketcherWorkbench",
  menus: withMenus(stdMenus(), [
    {
      title: "S&ketch",
      items: [
        ...sketchActions,
        "Sketcher_LeaveSketch",
        "Sketcher_CancelSketch",
        "Sketcher_ViewSketch",
        "Sketcher_ViewSection",
        "Sketcher_StopOperation",
        sub("Geometries", [
          "Sketcher_CreatePoint",
          "Sketcher_CreatePolyline",
          "Sketcher_CreateLine",
          "Sketcher_CreateArc",
          "Sketcher_Create3PointArc",
          "Sketcher_CreateCircle",
          "Sketcher_Create3PointCircle",
          "Sketcher_CreateRectangle",
          "Sketcher_CreateRectangle_Center",
          "Sketcher_CreateOblong",
          "Sketcher_CreateSlot",
          "Separator",
          "Sketcher_ToggleConstruction",
        ]),
        sub("Constraints", [
          "Sketcher_ConstrainCoincidentUnified",
          "Sketcher_ConstrainHorVer",
          "Sketcher_ConstrainHorizontal",
          "Sketcher_ConstrainVertical",
          "Sketcher_ConstrainParallel",
          "Sketcher_ConstrainPerpendicular",
          "Sketcher_ConstrainTangent",
          "Sketcher_ConstrainEqual",
          "Sketcher_ConstrainSymmetric",
          "Sketcher_ConstrainBlock",
          "Separator",
          "Sketcher_Dimension",
          "Sketcher_ConstrainDistanceX",
          "Sketcher_ConstrainDistanceY",
          "Sketcher_ConstrainDistance",
          "Sketcher_ConstrainRadius",
          "Sketcher_ConstrainDiameter",
          "Sketcher_ConstrainAngle",
          "Sketcher_ConstrainLock",
          "Separator",
          "Sketcher_ToggleDrivingConstraint",
          "Sketcher_ToggleActiveConstraint",
        ]),
      ],
    },
  ]),
  toolbars: [...stdToolbars(), { name: "Sketcher", items: sketchActions, hiddenInEditMode: false }],
};

export const WORKBENCH_DEFS: Record<Exclude<WorkbenchId, "NoneWorkbench">, Workbench> = {
  PartWorkbench: PART,
  PartDesignWorkbench: PARTDESIGN,
  SketcherWorkbench: SKETCHER,
};

export function workbench(id: WorkbenchId): Workbench {
  return id === "NoneWorkbench" ? PARTDESIGN : WORKBENCH_DEFS[id];
}

/** The menu bar and toolbars in effect: the workbench's, plus the Sketcher's edit-mode set while a sketch is edited. */
export function effectiveLayout(id: WorkbenchId, editingSketch: boolean): { menus: Menu[]; toolbars: Toolbar[] } {
  const wb = workbench(id);
  const toolbars = editingSketch ? [...wb.toolbars.filter((t) => !t.hiddenInEditMode), ...SKETCHER_EDIT_TOOLBARS] : wb.toolbars;
  const menus =
    editingSketch && id !== "SketcherWorkbench"
      ? withMenus(
          wb.menus,
          SKETCHER.menus.filter((m) => m.title === "S&ketch"),
        )
      : wb.menus;
  return { menus, toolbars };
}

/** Context menu of the tree (`setupContextMenu("Tree")`) with a selection. */
export const TREE_CONTEXT_MENU: MenuEntry[] = [
  "Std_ToggleFreeze",
  "Separator",
  "Std_ToggleVisibility",
  "Std_ShowSelection",
  "Std_HideSelection",
  "Std_ToggleSelectability",
  "Std_TreeSelectAllInstances",
  "Separator",
  "Std_RandomColor",
  "Std_ToggleTransparency",
  "Separator",
  "Std_Cut",
  "Std_Copy",
  "Std_Paste",
  "Std_Delete",
  "Std_SendToPythonConsole",
  "Std_Placement",
];

/** Context menu of the 3D view (`setupContextMenu("View")`). */
export function viewContextMenu(hasSelection: boolean): MenuEntry[] {
  const stdViews = sub("Standard Views", [
    "Std_ViewIsometric",
    "Separator",
    "Std_ViewHome",
    "Std_ViewFront",
    "Std_ViewTop",
    "Std_ViewRight",
    "Std_ViewRear",
    "Std_ViewBottom",
    "Std_ViewLeft",
    "Separator",
    "Std_ViewRotateLeft",
    "Std_ViewRotateRight",
  ]);
  const items: MenuEntry[] = [
    "Std_ViewFitAll",
    "Std_ViewFitSelection",
    "Std_AlignToSelection",
    "Std_DrawStyle",
    stdViews,
    "Separator",
    "Std_ViewDockUndockFullscreen",
  ];
  if (hasSelection) {
    items.push(
      "Separator",
      "Std_ToggleVisibility",
      "Std_ToggleSelectability",
      "Std_TreeSelection",
      "Std_RandomColor",
      "Std_ToggleTransparency",
      "Separator",
      "Std_Delete",
      "Std_SendToPythonConsole",
    );
  }
  return items;
}

/** Every command a workbench's menus or toolbars name (for the coverage table and the shortcut map). */
export function commandsOf(wb: Workbench): string[] {
  const out = new Set<string>();
  const walk = (e: MenuEntry) => {
    if (typeof e === "string") {
      if (e !== "Separator") out.add(e);
    } else e.items.forEach(walk);
  };
  wb.menus.forEach((m) => m.items.forEach(walk));
  wb.toolbars.forEach((t) => t.items.forEach(walk));
  return [...out];
}
