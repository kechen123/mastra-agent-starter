import { config } from '../../config.js';

/**
 * 通用对话指令。单独放在一个文件，便于：
 * - 工厂文件保持简短；
 * - 后续修改系统提示词时不必触动注册表 / 启动接线。
 */
export const generalChatInstructions = `你是${config.appShortName}通用对话助手。可以回答闲聊、百科、技术、生活等各类问题。回答使用中文，保持友善和准确。`;