请在当前这个独立项目完成README中的最近整秒四舍五入功能。这里是手机原生Termux中的Node.js项目，不要使用PRoot，也不要安装依赖。

请使用实际工具完成并保留可核对过程：

1. 读取README.md、package.json、src/elapsed.js和两个测试文件，确认功能要求和允许修改范围。
2. 通过shell实际执行 `node --test --test-reporter=tap test/baseline.test.js`，确认旧功能的基线；然后执行 `node --test --test-reporter=tap`，读取原始失败输出并指出至少一个具体的输入、预期值与实际值。不要跳过这次失败观察。
3. 仅修改src/elapsed.js实现要求。不要改测试、测试命令、项目说明或package.json，不要安装包或访问当前项目之外的文件。
4. 再实际执行 `node --test --test-reporter=tap`。如果仍失败，先阅读失败输出，再修正源代码并重新运行；保持所有测试原样。
5. 最终给出：读了哪些文件、真实运行了哪些命令、初次失败揭示了什么、改动摘要、最终通过/失败数量，以及仍未验证的部分。不要仅根据自己推理宣称测试通过。

不需要创建Git提交、不需要启动后台服务、不需要读取或显示API密钥。
