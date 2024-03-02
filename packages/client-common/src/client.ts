import type {
  BaseClickHouseClientConfigOptions,
  ClickHouseSettings,
  Connection,
  ConnExecResult,
  WithClickHouseSummary,
} from '@clickhouse/client-common'
import { type DataFormat, DefaultLogger } from '@clickhouse/client-common'
import type { InputJSON, InputJSONObjectEachRow } from './clickhouse_types'
import type {
  CloseStream,
  ImplementationDetails,
  MakeResultSet,
  ValuesEncoder,
} from './config'
import { getConnectionParams, prepareConfigWithURL } from './config'
import type { ConnPingResult } from './connection'
import type { BaseResultSet } from './result'

export interface BaseQueryParams {
  /** ClickHouse's settings that can be applied on query level. */
  clickhouse_settings?: ClickHouseSettings
  /** Parameters for query binding. https://clickhouse.com/docs/en/interfaces/http/#cli-queries-with-parameters */
  query_params?: Record<string, unknown>
  /** AbortSignal instance to cancel a request in progress. */
  abort_signal?: AbortSignal
  /** A specific `query_id` that will be sent with this request.
   * If it is not set, a random identifier will be generated automatically by the client. */
  query_id?: string
  session_id?: string
}

export interface QueryParams extends BaseQueryParams {
  /** Statement to execute. */
  query: string
  /** Format of the resulting dataset. */
  format?: DataFormat
}

export interface ExecParams extends BaseQueryParams {
  /** Statement to execute. */
  query: string
}

export type CommandParams = ExecParams
export type CommandResult = { query_id: string } & WithClickHouseSummary

export type InsertResult = {
  /**
   * Indicates whether the INSERT statement was executed on the server.
   * Will be `false` if there was no data to insert.
   * For example: if {@link InsertParams.values} was an empty array,
   * the client does not any requests to the server, and {@link executed} is false.
   */
  executed: boolean
  /**
   * Empty string if {@link executed} is false.
   * Otherwise, either {@link InsertParams.query_id} if it was set, or the id that was generated by the client.
   */
  query_id: string
} & WithClickHouseSummary

export type ExecResult<Stream> = ConnExecResult<Stream>
export type PingResult = ConnPingResult

export type InsertValues<Stream, T = unknown> =
  | ReadonlyArray<T>
  | Stream
  | InputJSON<T>
  | InputJSONObjectEachRow<T>

type NonEmptyArray<T> = [T, ...T[]]

/** {@link except} field contains a non-empty list of columns to exclude when generating `(* EXCEPT (...))` clause */
export interface InsertColumnsExcept {
  except: NonEmptyArray<string>
}

export interface InsertParams<Stream = unknown, T = unknown>
  extends BaseQueryParams {
  /** Name of a table to insert into. */
  table: string
  /** A dataset to insert. */
  values: InsertValues<Stream, T>
  /** Format of the dataset to insert. Default: `JSONCompactEachRow` */
  format?: DataFormat
  /**
   * Allows to specify which columns the data will be inserted into.
   * Accepts either an array of strings (column names) or an object of {@link InsertColumnsExcept} type.
   * Examples of generated queries:
   *
   * - An array such as `['a', 'b']` will generate: `INSERT INTO table (a, b) FORMAT DataFormat`
   * - An object such as `{ except: ['a', 'b'] }` will generate: `INSERT INTO table (* EXCEPT (a, b)) FORMAT DataFormat`
   *
   * By default, the data is inserted into all columns of the {@link InsertParams.table},
   * and the generated statement will be: `INSERT INTO table FORMAT DataFormat`.
   *
   * See also: https://clickhouse.com/docs/en/sql-reference/statements/insert-into */
  columns?: NonEmptyArray<string> | InsertColumnsExcept
}

export class ClickHouseClient<Stream = unknown> {
  private readonly clientClickHouseSettings: ClickHouseSettings
  private readonly connection: Connection<Stream>
  private readonly makeResultSet: MakeResultSet<Stream>
  private readonly valuesEncoder: ValuesEncoder<Stream>
  private readonly closeStream: CloseStream<Stream>
  private readonly sessionId?: string

  constructor(
    config: BaseClickHouseClientConfigOptions & ImplementationDetails<Stream>
  ) {
    const logger = config?.log?.LoggerClass
      ? new config.log.LoggerClass()
      : new DefaultLogger()
    const configWithURL = prepareConfigWithURL(
      config,
      logger,
      config.impl.handle_specific_url_params ?? null
    )
    const connectionParams = getConnectionParams(configWithURL, logger)
    this.clientClickHouseSettings = connectionParams.clickhouse_settings
    this.sessionId = config.session_id
    this.connection = config.impl.make_connection(
      configWithURL,
      connectionParams
    )
    this.makeResultSet = config.impl.make_result_set
    this.valuesEncoder = config.impl.values_encoder
    this.closeStream = config.impl.close_stream
  }

  /**
   * Used for most statements that can have a response, such as SELECT.
   * FORMAT clause should be specified separately via {@link QueryParams.format} (default is JSON)
   * Consider using {@link ClickHouseClient.insert} for data insertion,
   * or {@link ClickHouseClient.command} for DDLs.
   */
  async query(params: QueryParams): Promise<BaseResultSet<Stream>> {
    const format = params.format ?? 'JSON'
    const query = formatQuery(params.query, format)
    const { stream, query_id } = await this.connection.query({
      query,
      ...this.withClientQueryParams(params),
    })
    return this.makeResultSet(stream, format, query_id)
  }

  /**
   * It should be used for statements that do not have any output,
   * when the format clause is not applicable, or when you are not interested in the response at all.
   * Response stream is destroyed immediately as we do not expect useful information there.
   * Examples of such statements are DDLs or custom inserts.
   * If you are interested in the response data, consider using {@link ClickHouseClient.exec}
   */
  async command(params: CommandParams): Promise<CommandResult> {
    const { stream, query_id, summary } = await this.exec(params)
    await this.closeStream(stream)
    return { query_id, summary }
  }

  /**
   * Similar to {@link ClickHouseClient.command}, but for the cases where the output is expected,
   * but format clause is not applicable. The caller of this method is expected to consume the stream,
   * otherwise, the request will eventually be timed out.
   */
  async exec(params: ExecParams): Promise<ExecResult<Stream>> {
    const query = removeTrailingSemi(params.query.trim())
    return await this.connection.exec({
      query,
      ...this.withClientQueryParams(params),
    })
  }

  /**
   * The primary method for data insertion. It is recommended to avoid arrays in case of large inserts
   * to reduce application memory consumption and consider streaming for most of such use cases.
   * As the insert operation does not provide any output, the response stream is immediately destroyed.
   * In case of a custom insert operation, such as, for example, INSERT FROM SELECT,
   * consider using {@link ClickHouseClient.command}, passing the entire raw query there (including FORMAT clause).
   */
  async insert<T>(params: InsertParams<Stream, T>): Promise<InsertResult> {
    if (Array.isArray(params.values) && params.values.length === 0) {
      return { executed: false, query_id: '' }
    }

    const format = params.format || 'JSONCompactEachRow'
    this.valuesEncoder.validateInsertValues(params.values, format)

    const query = getInsertQuery(params, format)
    const result = await this.connection.insert({
      query,
      values: this.valuesEncoder.encodeValues(params.values, format),
      ...this.withClientQueryParams(params),
    })
    return { ...result, executed: true }
  }

  /**
   * Health-check request. It does not throw if an error occurs -
   * the error is returned inside the result object.
   */
  async ping(): Promise<PingResult> {
    return await this.connection.ping()
  }

  /**
   * Shuts down the underlying connection.
   * This method should ideally be called only once per application lifecycle,
   * for example, during the graceful shutdown phase.
   */
  async close(): Promise<void> {
    return await this.connection.close()
  }

  private withClientQueryParams(params: BaseQueryParams): BaseQueryParams {
    return {
      clickhouse_settings: {
        ...this.clientClickHouseSettings,
        ...params.clickhouse_settings,
      },
      query_params: params.query_params,
      abort_signal: params.abort_signal,
      query_id: params.query_id,
      session_id: this.sessionId,
    }
  }
}

function formatQuery(query: string, format: DataFormat): string {
  query = query.trim()
  query = removeTrailingSemi(query)
  return query + ' \nFORMAT ' + format
}

function removeTrailingSemi(query: string) {
  let lastNonSemiIdx = query.length
  for (let i = lastNonSemiIdx; i > 0; i--) {
    if (query[i - 1] !== ';') {
      lastNonSemiIdx = i
      break
    }
  }
  if (lastNonSemiIdx !== query.length) {
    return query.slice(0, lastNonSemiIdx)
  }
  return query
}

function isInsertColumnsExcept(obj: unknown): obj is InsertColumnsExcept {
  return (
    obj !== undefined &&
    obj !== null &&
    typeof obj === 'object' &&
    // Avoiding ESLint no-prototype-builtins error
    Object.prototype.hasOwnProperty.call(obj, 'except')
  )
}

function getInsertQuery<T>(
  params: InsertParams<T>,
  format: DataFormat
): string {
  let columnsPart = ''
  if (params.columns !== undefined) {
    if (Array.isArray(params.columns) && params.columns.length > 0) {
      columnsPart = ` (${params.columns.join(', ')})`
    } else if (
      isInsertColumnsExcept(params.columns) &&
      params.columns.except.length > 0
    ) {
      columnsPart = ` (* EXCEPT (${params.columns.except.join(', ')}))`
    }
  }
  return `INSERT INTO ${params.table.trim()}${columnsPart} FORMAT ${format}`
}
