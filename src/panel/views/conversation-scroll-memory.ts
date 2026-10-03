export type ConversationScrollChannel = "content" | "reasoning" | "tools" | "meta";

export class ConversationScrollMemory {
  private positions = new Map<string, Map<ConversationScrollChannel, number>>();

  remember(streamId: string, channel: ConversationScrollChannel, scrollTop: number): void {
    if (!Number.isFinite(scrollTop)) return;
    let channels = this.positions.get(streamId);
    if (!channels) {
      channels = new Map();
      this.positions.set(streamId, channels);
    }
    channels.set(channel, Math.max(0, scrollTop));
  }

  restore(
    streamId: string,
    channel: ConversationScrollChannel,
    scrollHeight: number,
    clientHeight: number,
  ): number | undefined {
    const remembered = this.positions.get(streamId)?.get(channel);
    if (remembered == null) return undefined;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    return Math.min(remembered, maxScroll);
  }

  clear(): void {
    this.positions.clear();
  }
}
