import { CONVERSATION_EXTRA_CSS } from './conversation-styles.js'

/** conversation 模块补充样式：模块内一次性注入（幂等，重复挂载无害）。 */
export function ConversationStyles() {
  return <style dangerouslySetInnerHTML={{ __html: CONVERSATION_EXTRA_CSS }} />
}
