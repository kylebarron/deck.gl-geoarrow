import { assert } from "@deck.gl/core/typed";
import * as arrow from "apache-arrow";
import {
  LineStringData,
  LineStringVector,
  MultiLineStringData,
  MultiLineStringVector,
  MultiPointData,
  MultiPointVector,
  MultiPolygonData,
  MultiPolygonVector,
  PointData,
  PointVector,
  PolygonData,
  PolygonVector,
} from "./types";

export type TypedArray =
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

export function findGeometryColumnIndex(
  schema: arrow.Schema,
  extensionName: string,
  geometryColumnName?: string | null,
): number | null {
  const index = schema.fields.findIndex(
    (field) =>
      field.name === geometryColumnName ||
      field.metadata.get("ARROW:extension:name") === extensionName,
  );
  return index !== -1 ? index : null;
}

/**
 * Returns `true` if the input is a reference to a column in the table
 */
export function isColumnReference(input: any): input is string {
  return typeof input === "string";
}

function isDataInterleavedCoords(
  data: arrow.Data,
): data is arrow.Data<arrow.FixedSizeList<arrow.Float64>> {
  // TODO: also check 2 or 3d? Float64?
  return data.type instanceof arrow.FixedSizeList;
}

function isDataSeparatedCoords(
  data: arrow.Data,
): data is arrow.Data<arrow.Struct<{ x: arrow.Float64; y: arrow.Float64 }>> {
  // TODO: also check child names? Float64?
  return data.type instanceof arrow.Struct;
}

/**
 * Convert geoarrow Struct coordinates to FixedSizeList coords
 *
 * The GeoArrow spec allows for either separated or interleaved coords, but at
 * this time deck.gl only supports interleaved.
 */
// TODO: this hasn't been tested yet
function convertStructToFixedSizeList(
  coords:
    | arrow.Data<arrow.FixedSizeList<arrow.Float64>>
    | arrow.Data<arrow.Struct<{ x: arrow.Float64; y: arrow.Float64 }>>,
): arrow.Data<arrow.FixedSizeList<arrow.Float64>> {
  if (isDataInterleavedCoords(coords)) {
    return coords;
  } else if (isDataSeparatedCoords(coords)) {
    // TODO: support 3d
    const interleavedCoords = new Float64Array(coords.length * 2);
    const [xChild, yChild] = coords.children;
    for (let i = 0; i < coords.length; i++) {
      interleavedCoords[i * 2] = xChild.values[i];
      interleavedCoords[i * 2 + 1] = yChild.values[i];
    }

    const childDataType = new arrow.Float64();
    const dataType = new arrow.FixedSizeList(
      2,
      new arrow.Field("coords", childDataType),
    );

    const interleavedCoordsData = arrow.makeData({
      type: childDataType,
      length: interleavedCoords.length,
    });

    const data = arrow.makeData({
      type: dataType,
      length: coords.length,
      nullCount: coords.nullCount,
      nullBitmap: coords.nullBitmap,
      child: interleavedCoordsData,
    });
    return data;
  }

  assert(false);
}

type AssignAccessorProps = {
  /** The object on which to assign the resolved accesor */
  props: object;
  /** The name of the prop to set */
  propName: string;
  /** The user-supplied input to the layer. Must either be a scalar value or a reference to a column in the table. */
  propInput: any;
  /** Numeric index in the table */
  chunkIdx: number;
  /** a map from the geometry index to the coord offsets for that geometry. */
  geomCoordOffsets?: Int32Array | null;
};

/**
 * Resolve accessor and assign to props object
 *
 * This is useful as a helper function because a scalar prop is set at the top
 * level while a vectorized prop is set inside data.attributes
 *
 */
export function assignAccessor(args: AssignAccessorProps) {
  const { props, propName, propInput, chunkIdx, geomCoordOffsets } = args;

  if (propInput === undefined) {
    return;
  }

  if (propInput instanceof arrow.Vector) {
    const columnData = propInput.data[chunkIdx];

    if (arrow.DataType.isFixedSizeList(columnData)) {
      assert(columnData.children.length === 1);
      let values = columnData.children[0].values;

      if (geomCoordOffsets) {
        values = expandArrayToCoords(
          values,
          columnData.type.listSize,
          geomCoordOffsets,
        );
      }

      // @ts-expect-error Property 'data' does not exist on type 'object'.
      props.data.attributes[propName] = {
        value: values,
        size: columnData.type.listSize,
        // Set to `true` to signify that colors are already 0-255, and deck/luma
        // does not need to rescale
        // https://github.com/visgl/deck.gl/blob/401d624c0529faaa62125714c376b3ba3b8f379f/docs/api-reference/core/attribute-manager.md?plain=1#L66
        normalized: true,
      };
    } else if (arrow.DataType.isFloat(columnData)) {
      let values = columnData.values;

      if (geomCoordOffsets) {
        values = expandArrayToCoords(values, 1, geomCoordOffsets);
      }

      // @ts-expect-error Property 'data' does not exist on type 'object'.
      props.data.attributes[propName] = {
        value: values,
        size: 1,
      };
    }
  } else {
    props[propName] = propInput;
  }
}

/**
 * Expand an array from "one element per geometry" to "one element per coordinate"
 *
 * @param input: the input array to expand
 * @param size : the number of nested elements in the input array per geometry. So for example, for RGB data this would be 3, for RGBA this would be 4. For radius, this would be 1.
 * @param geomOffsets : an offsets array mapping from the geometry to the coordinate indexes. So in the case of a LineStringArray, this is retrieved directly from the GeoArrow storage. In the case of a PolygonArray, this comes from the resolved indexes that need to be given to the SolidPolygonLayer anyways.
 *
 * @return  {TypedArray} values expanded to be per-coordinate
 */
export function expandArrayToCoords<T extends TypedArray>(
  input: T,
  size: number,
  geomOffsets: Int32Array,
): T {
  const numCoords = geomOffsets[geomOffsets.length - 1];
  // @ts-expect-error
  const outputArray: T = new input.constructor(numCoords * size);

  // geomIdx is an index into the geomOffsets array
  // geomIdx is also the geometry/table index
  for (let geomIdx = 0; geomIdx < geomOffsets.length - 1; geomIdx++) {
    // geomOffsets maps from the geometry index to the coord index
    // So here we get the range of coords that this geometry covers
    const lastCoordIdx = geomOffsets[geomIdx];
    const nextCoordIdx = geomOffsets[geomIdx + 1];

    // Iterate over this range of coord indices
    for (let coordIdx = lastCoordIdx; coordIdx < nextCoordIdx; coordIdx++) {
      // Iterate over size
      for (let i = 0; i < size; i++) {
        // Copy from the geometry index in `input` to the coord index in
        // `output`
        outputArray[coordIdx * size + i] = input[geomIdx * size + i];
      }
    }
  }

  return outputArray;
}

/**
 * Get a geometry vector with the specified extension type name from the table.
 */
export function getGeometryVector(
  table: arrow.Table,
  geoarrowTypeName: string,
): arrow.Vector | null {
  const geometryColumnIdx = findGeometryColumnIndex(
    table.schema,
    geoarrowTypeName,
  );

  if (geometryColumnIdx === null) {
    return null;
    // throw new Error(`No column found with extension type ${geoarrowTypeName}`);
  }

  return table.getChildAt(geometryColumnIdx);
}

export function isPointVector(vector: arrow.Vector): vector is PointVector {
  // Check FixedSizeList
  if (!arrow.DataType.isFixedSizeList(vector.type)) {
    return false;
  }

  // Check list size of 2 or 3
  if (vector.type.listSize !== 2 && vector.type.listSize !== 3) {
    return false;
  }

  // Check child of FixedSizeList is floating type
  if (!arrow.DataType.isFloat(vector.type.children[0])) {
    return false;
  }

  return true;
}

export function isLineStringVector(
  vector: arrow.Vector,
): vector is LineStringVector {
  // Check the outer vector is a List
  if (!arrow.DataType.isList(vector.type)) {
    return false;
  }

  // Check the child is a point vector
  if (!isPointVector(vector.getChildAt(0))) {
    return false;
  }

  return true;
}

export function isPolygonVector(vector: arrow.Vector): vector is PolygonVector {
  // Check the outer vector is a List
  if (!arrow.DataType.isList(vector.type)) {
    return false;
  }

  // Check the child is a linestring vector
  if (!isLineStringVector(vector.getChildAt(0))) {
    return false;
  }

  return true;
}

export function isMultiPointVector(
  vector: arrow.Vector,
): vector is MultiPointVector {
  // Check the outer vector is a List
  if (!arrow.DataType.isList(vector.type)) {
    return false;
  }

  // Check the child is a point vector
  if (!isPointVector(vector.getChildAt(0))) {
    return false;
  }

  return true;
}

export function isMultiLineStringVector(
  vector: arrow.Vector,
): vector is MultiLineStringVector {
  // Check the outer vector is a List
  if (!arrow.DataType.isList(vector.type)) {
    return false;
  }

  // Check the child is a linestring vector
  if (!isLineStringVector(vector.getChildAt(0))) {
    return false;
  }

  return true;
}

export function isMultiPolygonVector(
  vector: arrow.Vector,
): vector is MultiPolygonVector {
  // Check the outer vector is a List
  if (!arrow.DataType.isList(vector.type)) {
    return false;
  }

  // Check the child is a polygon vector
  if (!isPolygonVector(vector.getChildAt(0))) {
    return false;
  }

  return true;
}

export function getListNestingLevels(data: arrow.Data): number {
  let nestingLevels = 0;
  if (arrow.DataType.isList(data.type)) {
    nestingLevels += 1;
    data = data.children[0];
  }
  return nestingLevels;
}

export function getPointChild(data: PointData): arrow.Data<arrow.Float> {
  // @ts-expect-error
  return data.children[0];
}

export function getLineStringChild(data: LineStringData): PointData {
  // @ts-expect-error
  return data.children[0];
}

export function getPolygonChild(data: PolygonData): LineStringData {
  // @ts-expect-error
  return data.children[0];
}

export function getMultiPointChild(data: MultiPointData): PointData {
  // @ts-expect-error
  return data.children[0];
}

export function getMultiLineStringChild(
  data: MultiLineStringData,
): LineStringData {
  // @ts-expect-error
  return data.children[0];
}

export function getMultiPolygonChild(data: MultiPolygonData): PolygonData {
  // @ts-expect-error
  return data.children[0];
}

export function getMultiLineStringResolvedOffsets(
  data: MultiLineStringData,
): Int32Array {
  const geomOffsets = data.valueOffsets;
  const lineStringData = getMultiLineStringChild(data);
  const ringOffsets = lineStringData.valueOffsets;

  const resolvedRingOffsets = new Int32Array(geomOffsets.length);
  for (let i = 0; i < resolvedRingOffsets.length; ++i) {
    // Perform the lookup into the ringIndices array using the geomOffsets
    // array
    resolvedRingOffsets[i] = ringOffsets[geomOffsets[i]];
  }

  return resolvedRingOffsets;
}

export function getPolygonResolvedOffsets(data: PolygonData): Int32Array {
  const geomOffsets = data.valueOffsets;
  const ringData = getPolygonChild(data);
  const ringOffsets = ringData.valueOffsets;

  const resolvedRingOffsets = new Int32Array(geomOffsets.length);
  for (let i = 0; i < resolvedRingOffsets.length; ++i) {
    // Perform the lookup into the ringIndices array using the geomOffsets
    // array
    resolvedRingOffsets[i] = ringOffsets[geomOffsets[i]];
  }

  return resolvedRingOffsets;
}

export function getMultiPolygonResolvedOffsets(
  data: MultiPolygonData,
): Int32Array {
  const polygonData = getMultiPolygonChild(data);
  const ringData = getPolygonChild(polygonData);

  const geomOffsets = data.valueOffsets;
  const polygonOffsets = polygonData.valueOffsets;
  const ringOffsets = ringData.valueOffsets;

  const resolvedRingOffsets = new Int32Array(geomOffsets.length);
  for (let i = 0; i < resolvedRingOffsets.length; ++i) {
    resolvedRingOffsets[i] = ringOffsets[polygonOffsets[geomOffsets[i]]];
  }

  return resolvedRingOffsets;
}

/**
 * Invert offsets so that lookup can go in the opposite direction
 */
export function invertOffsets(
  offsets: Int32Array,
): Uint8Array | Uint16Array | Uint32Array {
  const largestOffset = offsets[offsets.length - 1];

  const arrayConstructor =
    offsets.length < Math.pow(2, 8)
      ? Uint8Array
      : offsets.length < Math.pow(2, 16)
        ? Uint16Array
        : Uint32Array;

  const invertedOffsets = new arrayConstructor(largestOffset);
  for (let arrayIdx = 0; arrayIdx < offsets.length - 1; arrayIdx++) {
    const thisOffset = offsets[arrayIdx];
    const nextOffset = offsets[arrayIdx + 1];
    for (let offset = thisOffset; offset < nextOffset; offset++) {
      invertedOffsets[offset] = arrayIdx;
    }
  }

  return invertedOffsets;
}

// TODO: better typing
export function extractAccessorsFromProps(
  props: Record<string, any>,
  excludeKeys: string[],
): [Record<string, any>, Record<string, any>] {
  const accessors = {};
  const otherProps = {};
  for (const [key, value] of Object.entries(props)) {
    if (excludeKeys.includes(key)) {
      continue;
    }

    if (key.startsWith("get")) {
      accessors[key] = value;
    } else {
      otherProps[key] = value;
    }
  }

  return [accessors, otherProps];
}
