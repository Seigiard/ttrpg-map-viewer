import { defineRule, type ESTree } from "@oxlint/plugins";

const FORBIDDEN_PROMISE_BRIDGES = new Set(["promise", "tryPromise"]);

function importedName(specifier: ESTree.ImportSpecifier): string | undefined {
  if (specifier.imported.type === "Identifier") return specifier.imported.name;

  return specifier.imported.value;
}

/** `Effect.<member>` where `Effect` is one of the names bound to the effect module. */
function effectMember(node: ESTree.Node | null | undefined, effectNames: ReadonlySet<string>): string | undefined {
  if (
    node?.type !== "MemberExpression" ||
    node.computed ||
    node.object.type !== "Identifier" ||
    node.property.type !== "Identifier" ||
    !effectNames.has(node.object.name)
  ) {
    return undefined;
  }

  return node.property.name;
}

/** `Effect.promise(...).pipe(..., Effect.uninterruptible, ...)`: nothing can interrupt the wait, so nothing is abandoned. */
function isPipedUninterruptible(call: ESTree.CallExpression, effectNames: ReadonlySet<string>): boolean {
  const member = call.parent;

  if (
    member?.type !== "MemberExpression" ||
    member.object !== call ||
    member.property.type !== "Identifier" ||
    member.property.name !== "pipe"
  ) {
    return false;
  }

  const pipeCall = member.parent;

  return pipeCall?.type === "CallExpression" && pipeCall.arguments.some((arg) => effectMember(arg, effectNames) === "uninterruptible");
}

/** Inside an argument of `Effect.acquireRelease`: acquire and release both run uninterruptibly. */
function isInsideAcquireRelease(call: ESTree.CallExpression, effectNames: ReadonlySet<string>): boolean {
  let current: ESTree.Node = call;

  while (current.parent) {
    const parent: ESTree.Node = current.parent;

    if (
      parent.type === "CallExpression" &&
      effectMember(parent.callee, effectNames) === "acquireRelease" &&
      parent.arguments.some((arg) => arg === current)
    ) {
      return true;
    }

    current = parent;
  }

  return false;
}

export const noDirectEffectPromiseRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Use ownedPromise instead of an interruptible Effect.promise or Effect.tryPromise.",
    },
    messages: {
      directPromiseBridge:
        "Effect.{{method}} abandons the Promise on interruption. Use ownedPromise, pipe it through Effect.uninterruptible, or disable this line with the reason abandoning is safe.",
    },
  },
  createOnce(context) {
    const effectNames = new Set<string>();

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "effect") return;

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") effectNames.add(specifier.local.name);

          if (specifier.type === "ImportSpecifier" && importedName(specifier) === "Effect") effectNames.add(specifier.local.name);
        }
      },
      CallExpression(node) {
        const method = effectMember(node.callee, effectNames);

        if (method === undefined || !FORBIDDEN_PROMISE_BRIDGES.has(method)) return;

        if (isPipedUninterruptible(node, effectNames) || isInsideAcquireRelease(node, effectNames)) return;

        context.report({ node: node.callee, messageId: "directPromiseBridge", data: { method } });
      },
    };
  },
});
