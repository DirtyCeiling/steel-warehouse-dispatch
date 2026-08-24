export interface Span {
  id: string;
  name: string;
  length: number;
  width: number;
  position: number;
}

export interface Location {
  id: string;
  spanId: string;
  row: number;
  column: number;
  status: 'empty' | 'occupied' | 'reserved';
  capacity: number;
  steelCoilId?: string;
}

export interface SteelCoil {
  id: string;
  coilNumber: string;
  specification: string;
  weight: number;
  diameter: number;
  material: string;
  status: 'in-stock' | 'reserved' | 'shipping';
  locationId?: string;
}

export interface Task {
  id: string;
  type: 'inbound' | 'outbound' | 'transfer';
  status: 'pending' | 'executing' | 'completed' | 'failed';
  steelCoilId: string;
  fromLocationId?: string;
  toLocationId?: string;
  createTime: string;
  completeTime?: string;
}

export interface Warehouse {
  id: string;
  name: string;
  totalArea: number;
  numberOfSpans: number;
  spans: Span[];
}
