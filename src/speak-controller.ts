export class SpeakController {
  private utterance: SpeechSynthesisUtterance | null = null;
  private generation = 0;
  onChange: ((speaking: boolean) => void) | null = null;

  start(text: string) {
    if (typeof speechSynthesis === "undefined") {
      console.warn("[xiaoyuanAgent] speechSynthesis API not available in this environment");
      this.notifyChange(false);
      return;
    }
    this.stop();
    if (!text.trim()) return;
    const gen = ++this.generation;
    try {
      // 只去掉 markdown 标记符号；原先直接删掉 `_` 会把 snake_case 单词连成一团，
      // 朗读时会念出一串不明单词，这里替换成空格而不是删掉
      const cleanText = text.replace(/[#*`[\]]/g, "").replace(/_+/g, " ");
      this.utterance = new SpeechSynthesisUtterance(cleanText);
      this.utterance.lang = "zh-CN";
      this.utterance.rate = 1.0;
      this.utterance.onend = () => {
        if (this.generation !== gen) return;
        this.notifyChange(false);
      };
      this.utterance.onerror = (e) => {
        if (this.generation !== gen) return;
        if (e.error !== "canceled" && e.error !== "interrupted") {
          console.warn("[xiaoyuanAgent] speechSynthesis error:", e.error);
        }
        this.notifyChange(false);
      };
      speechSynthesis.speak(this.utterance);
      this.notifyChange(true);
    } catch (err: unknown) {
      console.warn("[xiaoyuanAgent] failed to start speech synthesis:", err);
      this.utterance = null;
      this.notifyChange(false);
    }
  }

  stop() {
    this.generation++;
    // 解绑回调：cancel() 会触发 onend/onerror，不清掉的话这里会
    // 对已经作废的那次朗读做出响应（generation 挡住了，但仍属资源泄漏）
    if (this.utterance) {
      this.utterance.onend = null;
      this.utterance.onerror = null;
    }
    if (typeof speechSynthesis !== "undefined") {
      try {
        speechSynthesis.cancel();
      } catch (err: unknown) {
        console.warn("[xiaoyuanAgent] speechSynthesis.cancel failed:", err);
      }
    }
    this.utterance = null;
    this.notifyChange(false);
  }

  private notifyChange(speaking: boolean) {
    try {
      this.onChange?.(speaking);
    } catch (err: unknown) {
      console.warn("[xiaoyuanAgent] onChange callback failed:", err);
    }
  }
}
