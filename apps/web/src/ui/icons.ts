/**
 * FreeCAD's icons (copied into public/icons by tooling/icons/sync.ts) and the tree icon of each
 * object type, after the view providers' `sPixmap` / `getIcon()`.
 */
import iconNames from "../generated/icon-names.json";

const AVAILABLE = new Set<string>(iconNames as string[]);

export function hasIcon(name: string): boolean {
  return AVAILABLE.has(name);
}

/** URL of an icon, or of FreeCAD's `px` placeholder when the fork has no such SVG. */
export function iconUrl(name: string | undefined): string {
  const base = import.meta.env?.BASE_URL ?? "/";
  if (name && AVAILABLE.has(name)) return `${base}icons/${name}.svg`;
  return `${base}icons/px.svg`;
}

/** Type → tree icon, most specific first (the view provider's pixmap). */
const TYPE_ICONS: Record<string, string> = {
  "App::DocumentObjectGroup": "folder",
  "App::Part": "Geofeaturegroup",
  "App::Origin": "Std_CoordinateSystem",
  "App::LocalCoordinateSystem": "Std_CoordinateSystem",
  "App::Line": "Std_Axis",
  "App::Plane": "Std_Plane",
  "App::Point": "Std_Point",
  "App::Link": "Link",
  "App::VarSet": "VarSet",
  "App::TextDocument": "TextDocument",
  "App::FeaturePython": "Tree_Python",
  "Part::Box": "Part_Box_Parametric",
  "Part::Cylinder": "Part_Cylinder_Parametric",
  "Part::Sphere": "Part_Sphere_Parametric",
  "Part::Cone": "Part_Cone_Parametric",
  "Part::Torus": "Part_Torus_Parametric",
  "Part::Ellipsoid": "Part_Ellipsoid_Parametric",
  "Part::Prism": "Part_Prism_Parametric",
  "Part::Wedge": "Part_Wedge_Parametric",
  "Part::Plane": "Part_Plane_Parametric",
  "Part::Helix": "Part_Helix_Parametric",
  "Part::Spiral": "Part_Spiral_Parametric",
  "Part::Circle": "Part_Circle_Parametric",
  "Part::Ellipse": "Part_Ellipse_Parametric",
  "Part::Line": "Part_Line_Parametric",
  "Part::Vertex": "Part_Point_Parametric",
  "Part::RegularPolygon": "Part_Polygon_Parametric",
  "Part::Cut": "Part_Cut",
  "Part::Fuse": "Part_Fuse",
  "Part::MultiFuse": "Part_Fuse",
  "Part::Common": "Part_Common",
  "Part::MultiCommon": "Part_Common",
  "Part::Section": "Part_Section",
  "Part::Compound": "Part_Compound",
  "Part::Extrusion": "Part_Extrude",
  "Part::Revolution": "Part_Revolve",
  "Part::Mirroring": "Part_Mirror",
  "Part::Fillet": "Part_Fillet",
  "Part::Chamfer": "Part_Chamfer",
  "Part::Loft": "Part_Loft",
  "Part::Sweep": "Part_Sweep",
  "Part::Offset": "Part_Offset",
  "Part::Offset2D": "Part_Offset2D",
  "Part::Thickness": "Part_Thickness",
  "Part::Refine": "Part_Refine_Shape",
  "Part::Scale": "Part_Scale",
  "Part::Face": "Part_MakeFace",
  "Part::RuledSurface": "Part_RuledSurface",
  "Part::Import": "Part_FeatureImport",
  "Part::Part2DObject": "Part_2D_object",
  "Part::Feature": "Part_3D_object",
  "PartDesign::Body": "PartDesign_Body",
  "PartDesign::Pad": "PartDesign_Pad",
  "PartDesign::Pocket": "PartDesign_Pocket",
  "PartDesign::Revolution": "PartDesign_Revolution",
  "PartDesign::Groove": "PartDesign_Groove",
  "PartDesign::Hole": "PartDesign_Hole",
  "PartDesign::Fillet": "PartDesign_Fillet",
  "PartDesign::Chamfer": "PartDesign_Chamfer",
  "PartDesign::Draft": "PartDesign_Draft",
  "PartDesign::Thickness": "PartDesign_Thickness",
  "PartDesign::Mirrored": "PartDesign_Mirrored",
  "PartDesign::LinearPattern": "PartDesign_LinearPattern",
  "PartDesign::PolarPattern": "PartDesign_PolarPattern",
  "PartDesign::MultiTransform": "PartDesign_MultiTransform",
  "PartDesign::Boolean": "PartDesign_Boolean",
  "PartDesign::AdditiveLoft": "PartDesign_AdditiveLoft",
  "PartDesign::SubtractiveLoft": "PartDesign_SubtractiveLoft",
  "PartDesign::AdditivePipe": "PartDesign_AdditivePipe",
  "PartDesign::SubtractivePipe": "PartDesign_SubtractivePipe",
  "PartDesign::AdditiveHelix": "PartDesign_AdditiveHelix",
  "PartDesign::SubtractiveHelix": "PartDesign_SubtractiveHelix",
  "PartDesign::AdditiveBox": "PartDesign_AdditiveBox",
  "PartDesign::AdditiveCylinder": "PartDesign_AdditiveCylinder",
  "PartDesign::AdditiveSphere": "PartDesign_AdditiveSphere",
  "PartDesign::AdditiveCone": "PartDesign_AdditiveCone",
  "PartDesign::SubtractiveBox": "PartDesign_SubtractiveBox",
  "PartDesign::SubtractiveCylinder": "PartDesign_SubtractiveCylinder",
  "PartDesign::Plane": "PartDesign_Plane",
  "PartDesign::Line": "PartDesign_Line",
  "PartDesign::Point": "PartDesign_Point",
  "PartDesign::CoordinateSystem": "PartDesign_CoordinateSystem",
  "PartDesign::ShapeBinder": "PartDesign_ShapeBinder",
  "PartDesign::SubShapeBinder": "PartDesign_SubShapeBinder",
  "PartDesign::FeatureBase": "PartDesign_BaseFeature",
  "Sketcher::SketchObject": "Sketcher_Sketch",
  "Sketcher::SketchObjectPython": "Sketcher_Sketch",
};

/** Tree icon for an object: its type, else the nearest base type with an icon, else `Feature`. */
export function objectIcon(type: string, hierarchy: readonly string[] = []): string {
  for (const t of [type, ...hierarchy]) {
    const i = TYPE_ICONS[t];
    if (i) return i;
  }
  return "Feature";
}
