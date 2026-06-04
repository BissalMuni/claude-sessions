// 폰이 밀어넣는 입력을 SDK 의 AsyncIterable 로 흘려보내기 위한 큐.
// push() 로 항목을 넣고, close() 로 스트림을 끝낸다.
// query() 의 prompt 로 이 큐의 async iterator 를 넘기면 "스트리밍 입력 모드"가 된다.

export class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // 대기 중인 소비자들을 모두 done 으로 깨운다
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  // async iterable 프로토콜 구현
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}
