import { config } from '../../config.js';

/**
 * 模板指令 —— 替换为你正在构建的 Agent 的真实系统提示词。
 *
 * 把提示词单独放在一个文件，能让工厂文件保持简短，也避免每次修改提示词时
 * 都牵连注册表 / 启动接线。
 */
export const templateInstructions = `你是${config.appShortName}的占位 Agent。请用一句话说明这个 Agent 的角色与边界。`;