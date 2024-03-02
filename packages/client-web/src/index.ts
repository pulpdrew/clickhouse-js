export { createClient } from './client'
export { WebClickHouseClientConfigOptions as ClickHouseClientConfigOptions } from './config'
export { ResultSet } from './result_set'

/** Re-export @clickhouse/client-common types */
export {
  type BaseClickHouseClientConfigOptions,
  type BaseQueryParams,
  type QueryParams,
  type ExecParams,
  type InsertParams,
  type InsertValues,
  type CommandParams,
  type CommandResult,
  type ExecResult,
  type InsertResult,
  type DataFormat,
  type ErrorLogParams,
  type Logger,
  type LogParams,
  type ClickHouseSettings,
  type MergeTreeSettings,
  type Row,
  type ResponseJSON,
  type InputJSON,
  type InputJSONObjectEachRow,
  type BaseResultSet,
  type PingResult,
  ClickHouseError,
  ClickHouseLogLevel,
  ClickHouseClient,
  SettingsMap,
} from '@clickhouse/client-common'
