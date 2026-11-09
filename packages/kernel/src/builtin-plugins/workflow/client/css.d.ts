/** 插件自有 CSS 在编译期被内联为 JS 模块并注入宿主页面（见 client-compiler）。 */
declare module '*.css' {
  const css: string
  export default css
}
