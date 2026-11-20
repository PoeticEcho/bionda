const test = require('node:test');
const assert = require('node:assert/strict');

test('연결 주소와 이정이 있는 CCTV만 이름과 이정으로 정렬한다', async () => {
  const { cameraDirectory } = await import('../public/cctv-order.js');
  const url = 'https://example.com/live';
  const directory = cameraDirectory({ cctvs: [
    { name: '[광주대구선] 야로대교1', url }, { name: '우명교', url },
    { name: '[다른노선] 야로대교1', url }, { name: '해인사', url: '' },
    { name: '[광주대구선] 미상', url }, { name: '원평교', url: 'invalid' },
    { name: '가조터널', url }, { name: '옥포분기점_광주대구', url }
  ] });
  assert.deepEqual(directory.map(e => [e.displayName, e.position]), [
    ['우명교', '약 99.93k'], ['가조터널', '135.18k'],
    ['야로대교1', '144.58k'], ['옥포분기점', '176.00k']
  ]);
});
