import type { MergeTreeSettings, TableEngine } from './engines'
import type { Schema } from './schema'
import type { Infer, Shape } from './common'
import { getTableName, QueryFormatter } from './query_formatter'
import type { ClickHouseClient } from '../client'
import type { Row } from '../rows'
import type { WhereExpr } from './where'
import type { InsertStream, SelectResult } from './stream'
import type { ClickHouseSettings } from '../settings'
import type { NonEmptyArray } from './common'

// TODO: non-empty schema constraint
// TODO support more formats (especially JSONCompactEachRow)
export interface TableOptions<S extends Shape> {
  name: string
  schema: Schema<S>
  database?: string
}

export interface CreateTableOptions<S extends Shape> {
  engine: TableEngine
  order_by: NonEmptyArray<keyof S> // TODO: functions support
  if_not_exists?: boolean
  on_cluster?: string
  partition_by?: NonEmptyArray<keyof S> // TODO: functions support
  primary_key?: NonEmptyArray<keyof S> // TODO: functions support
  settings?: MergeTreeSettings // TODO: more settings and type constraints
  clickhouse_settings?: ClickHouseSettings
  // TODO: settings now moved to engines; decide whether we need it here
  // TODO: index
  // TODO: projections
  // TODO: TTL
}

export interface SelectOptions<S extends Shape> {
  columns?: NonEmptyArray<keyof S>
  where?: WhereExpr<S>
  order_by?: NonEmptyArray<[keyof S, 'ASC' | 'DESC']>
  clickhouse_settings?: ClickHouseSettings
  abort_signal?: AbortSignal
}

export interface InsertOptions<S extends Shape> {
  values: Infer<S>[] | InsertStream<Infer<S>>
  clickhouse_settings?: ClickHouseSettings
  abort_signal?: AbortSignal
}

export class Table<S extends Shape> {
  constructor(
    private readonly client: ClickHouseClient,
    private readonly options: TableOptions<S>
  ) {}

  // TODO: better types
  async create(options: CreateTableOptions<S>): Promise<unknown> {
    const query = QueryFormatter.createTable(this.options, options)
    return (await this.client.command({ query })).text()
  }

  insert({
    abort_signal,
    clickhouse_settings,
    values,
  }: InsertOptions<S>): Promise<void> {
    return this.client.insert({
      clickhouse_settings,
      abort_signal,
      table: getTableName(this.options),
      format: 'JSONEachRow',
      values,
    })
  }

  async select({
    abort_signal,
    clickhouse_settings,
    columns,
    order_by,
    where,
  }: SelectOptions<S> = {}): Promise<SelectResult<Infer<S>>> {
    const query = QueryFormatter.select(this.options, where, columns, order_by)
    const rows = await this.client.command({
      query,
      clickhouse_settings,
      abort_signal,
      format: 'JSONEachRow',
    })

    const stream = rows.asStream()
    async function* asyncGenerator() {
      for await (const row of stream) {
        const value = (row as Row).json() as unknown[]
        yield value as Infer<S>
      }
    }

    return {
      asyncGenerator,
      json: async () => {
        const result = []
        for await (const value of asyncGenerator()) {
          if (Array.isArray(value)) {
            result.push(...value)
          } else {
            result.push(value)
          }
        }
        return result
      },
    }
  }
}
