// A structural boundary avoids nominal SDK types leaking across workspace/module resolution.
export interface DatabaseResult<T> {
  data: T | null;
  error: { message: string } | null;
}
export interface DatabaseClient {
  readPage(
    table: string,
    ownerId: string,
    order: readonly string[],
    offset: number,
    limit: number,
  ): Promise<DatabaseResult<Record<string, unknown>[]>>;
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<DatabaseResult<unknown>>;
}
