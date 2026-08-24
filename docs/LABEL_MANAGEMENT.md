# 标签管理、数据库与 React UI

## 1. 责任边界

标签管理是独立业务模块，不属于 Gaussian 渲染器。场景卡片只管理 PLY、Streamed SOG 切片和体素状态；标签列表、初始化、删除与类型/文本查询位于“标签”页，详情和编辑位于右上角独立巡检点卡片。

可见的标签页由 React 19 绘制，使用原生表单语义处理中文 IME、焦点、键盘操作、查询和确认状态。React 不创建 Canvas、GraphicsDevice 或第二 Renderer，也不参与 Gaussian Shader、LOD 或拾取计算。当前唯一 PlayCanvas `Application` 只负责 GS、体素调试网格、标签世界空间 Mesh/法向线/Text Element 和场景射线。

页面采用与 SuperSplat 一致的深黑/灰阶/橙色视觉语言。React 根容器为 `pointer-events: none`，只有导航、业务面板和性能面板显式恢复指针；因此界面之外的视口事件会到达 PlayCanvas Canvas。数据与标签仍通过同一后端 API 和 SQLite 真源闭环，UI 重构不得复制或迁移业务状态到 Renderer。

## 2. 数据归属与真源

数据库位于 `var/labels.sqlite`，使用 Node.js 内置 SQLite、WAL、外键和 5 秒 busy timeout。每个标签必须同时保存：

- `datasetId`：标签所属场景，所有查询和修改都必须在该场景边界内；
- `sourceSha256`：不可变源 PLY 摘要；
- `visualRevision`：拾取时的活动 Streamed SOG 切片版本；
- 局部 Z-up 位置、PCA 法向、5px 圆选和驻留 LOD 证据；
- 名称、说明与标签类型。

四种类型为固定枚举：`缺陷点`、`常态化巡检点`、`关键巡检点`、`一般巡检点`。不允许任意字符串进入数据库。

启动时会扫描旧 `var/local-datasets/<id>/labels.json`，使用 `INSERT OR IGNORE` 幂等迁移。旧文件不删除，已存在的 SQLite 记录不被旧 JSON 覆盖；旧标签类型缺失时记为“一般巡检点”。

## 3. 业务闭环

1. 用户先在“场景”页查看一个已切片场景；标签页只读绑定当前已加载场景，不能自行切换所属场景；
2. 点击“在 GS 上新建标签”，当前已加载 LOD 完成 5px GPU 圆选和 PCA；
3. 选择结果先是未保存草稿，用户填写名称、说明并必选一个类型；
4. 确认后才写数据库，场景创建红色 Mesh、法向线和空间文字；
5. 标签页可做列表、名称/说明和类型查询；选中列表项或世界空间 Mesh 后，在右上角卡片查看和编辑；
6. 修改只改名称、说明和类型，不在管理界面伪造新几何；如需改位置或法向，应删除后重新拾取；
7. `label_references` 记录任务/航线等使用关系。存在引用时标签和所属场景都拒绝删除。

## 4. API

- `GET /api/datasets/:id/labels?type=&q=&limit=&offset=`：场景内列表、类型和文本查询；
- `GET /api/datasets/:id/labels/spatial?x=&y=&z=&radius=&type=&limit=`：场景内球形空间查询，按距离升序；
- `GET /api/labels/:id`：读取单个标签；
- `POST /api/datasets/:id/labels/select`：校验当前切片、圆选/PCA 证据和元数据后创建；
- `PATCH /api/labels/:id`：修改名称、说明和四类枚举；
- `DELETE /api/labels/:id`：删除未被使用的标签。旧的场景作用域删除路由暂保留兼容。

空间查询使用场景 ID 与 X/Y/Z 轴包围索引缩小候选集，再以三维欧氏距离做半径复核，不会跨场景返回标签。

空间查询 API 作为后端能力保留，但当前极简客户端不再展示“查询选中点周边”入口，也不会从标签页发起空间查询。
