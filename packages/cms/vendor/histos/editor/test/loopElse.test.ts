import { describe, expect, it } from 'vitest';
import { elseLast, loopElse, parse, print, sequentialUids, type LoopBlock, type XbBlock } from '@xb/dsl';
import { canDrop, moveTo } from '../src/lib/tree.ts';
import { componentProblem } from '../src/lib/speed.ts';

const tree = (dsl: string) => parse(dsl, { uid: sequentialUids('u') }).blocks;

describe('{:else} of a loop in the builder (D1)', () => {
  it('stays last after an insertion inside the loop, and the tree keeps its identity when nothing moves', () => {
    const blocks = tree('{#loop data.x as x}<p>{x}</p>{:else}<p>vuoto</p>{/loop}');
    expect(elseLast(blocks)).toBe(blocks);
    const loop = blocks[0] as LoopBlock;
    const appended: XbBlock[] = [{ ...loop, children: [...loop.children, ...tree('<section>nuovo</section>')] }];
    const fixed = elseLast(appended)[0] as LoopBlock;
    expect(fixed.children.map((c) => c.name), JSON.stringify(fixed.children.map((c) => [c.name, c.attrs]))).toEqual(['xb/element', 'xb/element', 'xb/branch']);
    expect(loopElse(fixed)?.children).toHaveLength(1);
    expect(print([fixed])).toContain('<section>nuovo</section>\n{:else}');
  });

  it('does not let {:else} move, nor blocks land after it', () => {
    const blocks = tree('<div>{#loop data.x as x}<p>{x}</p>{:else}<p>vuoto</p>{/loop}<h2>t</h2></div>');
    const json = JSON.stringify(blocks);
    const uidOf = (tag: string) => new RegExp(`"uid":"([a-z0-9]+)","tag":"${tag}"`).exec(json)![1]!;
    const loop = (blocks[0]!.children[0] as LoopBlock);
    const branch = loopElse(loop)!;
    expect(canDrop(blocks, branch.attrs.uid, uidOf('h2'), 'after')).toBe(false);
    expect(canDrop(blocks, uidOf('p'), uidOf('h2'), 'after')).toBe(true);
    const moved = elseLast(moveTo(blocks, uidOf('h2'), loop.attrs.uid, 'inside'));
    expect(loopElse(moved[0]!.children[0] as LoopBlock)?.attrs.uid).toBe(branch.attrs.uid);
  });

  it('a component made of a loop: the {:else} cannot read the loop variable', () => {
    expect(componentProblem(tree('{#loop data.x as x}<p>{x}</p>{:else}<p>niente</p>{/loop}'))).toBeNull();
    expect(componentProblem(tree('{#loop data.x as x}<p>{x}</p>{:else}<p>{x}</p>{/loop}'))).not.toBeNull();
  });
});
