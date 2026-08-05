
const X = 50.5;
const Y = 50.5;


let  VALUECOLOR ;

// const VALUECOLOR = {
//     buy: '#ffc8e6',
//     ask: '#b4dcc8',
//     buy1: '#ffafc8',
//     ask1: '#a0dcb4',
//     deficit: '#0000ff',
//     profit: '#ff0000',
//     hold: '#00ff00',
//     limit: '#EF2E2E'
// }

const BUYBACKGROUND = '#322810'
// const ASKBACKGROUND = '#103210'
const ASKBACKGROUND = '#103210'
const FONTCOLOR = '#7f7f7f'
class Chart {
    constructor(dom, width, height, step = 0.2, config ={}){
        const {
            barToBorder,
            barVolume,
            barWidth = 10,
            calcBarType,
            volumeScaleCount,
            volumeScaleHeight = 30,
            volumeScaleTick,
            volumeScaleType,
            volumeXOffset = 0,
            volumeYOffset = 0
        } = config
        this.ctx = dom.getContext('2d');
        this.rendered = false;
        this.barToBorder = barToBorder;
        this.barWidth =barWidth;
        this.volumeScaleHeight = volumeScaleHeight;
        this.volumeScaleType = volumeScaleType;
        this.volumeScaleCount =volumeScaleCount;
        this.volumeScaleTick = volumeScaleTick;
        this.volumeXOffset = volumeXOffset;
        this.volumeYOffset = volumeYOffset;
        this.width = width;
        this.height = height;
        this.step = parseFloat(step);
        this.data = [];
        this.start = 0;
        
        this.range = this.initRange();

        this.setColor();
        const decimal = (this.step.toString().split('.')[1] || []).length;
        this.decimal = decimal;
        this.placeOrder=[];  
        this.traded ={};
        this.init();
    }

    static getHeight(range, value, volumeScaleHeight){
        let start = 0;
        let before = 0;
        if(value >  range[range.length - 1]){
            return volumeScaleHeight * range.length + 30
        }
        for(let i= 0; i < range.length; i++ ){
            if(value <= range[i]){
                start = start + ((value-before) / (range[i]-before)) * volumeScaleHeight; 
                break
            }else {
                start = start + volumeScaleHeight;
                before = range[i];
            }
        }
        if(start){
            start = Math.floor(start) + 0.5
        }
        
        return start ;
    }
     init(){
        const ctx= this.ctx;
        debugger
        this.count = Math.floor((this.width - 150) / (this.barWidth * 2) ) * 2;
        
        
        let range = this.range;
        ctx.beginPath();
        ctx.moveTo(X + 50, Y+10);
        ctx.strokeStyle = '#404040'
        ctx.lineTo(this.width - 19.5,Y+10);
        ctx.stroke();
        
        this.renderRange(range);
       
    }
    setColor(type){
        if(type){
            VALUECOLOR = {
                buy: '#ef302d',
                ask: '#0f65a1',
                buy1: '#b31529',
                ask1: '#10559a',
                deficit: '#0000ff',
                profit: '#ff0000',
                hold: '#00ff00',
                limit: '#EF2E2E',
                low: '#00ff00',
                high: "#ffff00",
                order: '#fffbf0'
            }
        }else{
              
        
             VALUECOLOR = {
                buy: '#ffc8e6',
                ask: '#b4dcc8',
                buy1: '#ffafc8',
                ask1: '#a0dcb4',
                deficit: '#0000ff',
                profit: '#ff0000',
                hold: '#00ff00',
                limit: '#EF2E2E',
                low: '#00ff00',
                high: "#ffff00",
                 order: 'red'
            }
        }
       
        
    }
    initRange(){

        
        let {volumeScaleHeight, volumeScaleType, volumeScaleCount, volumeScaleTick, height} = this;
        let baseRange = null;
        
        switch(volumeScaleType){
            case 0:
                volumeScaleCount = Math.floor((height - 100)/volumeScaleHeight)
                break;
            case 2:
                volumeScaleCount = Math.floor((height - 100)/volumeScaleHeight)
                baseRange = [10, 20, 30, 50, 100, 200, 400, 500, 1000, 2000, 3000, 4000, 5000].slice(0, volumeScaleCount);
                break;
            case 3:
                baseRange = [10, 20, 30, 50, 100, 200, 400, 500, 1000, 2000, 3000, 4000, 5000].slice(0, volumeScaleCount);
        }
        if(!baseRange){
            baseRange = [];
            for(let i = 1; i <= volumeScaleCount; i++){
                baseRange.push(i*volumeScaleTick)
            }
        }
        return baseRange
    }
     renderRange(range){
        
        const ctx= this.ctx;
        ctx.textAlign = 'right'
        ctx.font= '12px 宋体';
        ctx.fillStyle= FONTCOLOR;
       
       
        let {volumeScaleHeight, width} = this;
        let start = 30
        const _Y = Y + volumeScaleHeight;
        ctx.save();
      
     
        range.forEach(e => {
            ctx.fillText(e.toString(), X - 10, _Y + start + 5);
            ctx.beginPath();
            ctx.strokeStyle = '#404040'
            ctx.moveTo(X, _Y + start);
            ctx.lineTo(X+ 50 , _Y + start);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(width - 30, _Y + start);
            ctx.lineTo(width - 5 , _Y + start);
            ctx.stroke();
            start = start + volumeScaleHeight;
        });
        ctx.restore()
    }
    resize( width, height){
        
        const ctx= this.ctx;
        this.width = width;
        this.height = height;
        ctx.width = width;
        ctx.height = height;
        this.range = this.initRange()
        this.init();
        
        this.initData(this.currentPrice);
        this.renderPrice()
    }
     initData(price){
         if(!price || price > Number.MAX_SAFE_INTEGER) return;
         
        const count = this.count / 2;
        const decimal = this.decimal;
        const data = []
        
        data.push({
            price: price.toFixed(decimal)
        })
        for(let i = 1; i <= count; i++ ){

            data.push({
                price: (price + this.step * i).toFixed(decimal)
            })
            data.unshift({
                price: (price - this.step * i).toFixed(decimal)
            })
        }
        if(this.data.length){
            this.getindex(data[data.length - 1].price);
            this.getindex(data[0].price)
            this.start = this.getindex(price, true) - count;
        }else {
            this.data = data;
        }
        
    }
    renderBakcground(){
        const ctx = this.ctx;
        const y = Y + 30;
        const _x = X + 50.5;
        const start = this.start;
        ctx.clearRect(_x-2 , y - 5 ,this.width - 30 - _x, this.height);
        const barWidth = this.barWidth;
       
        let buyIndex = this.buyIndex - start;
       
        if(buyIndex < 0) {
            buyIndex = 0;
        } 
        if( this.buyIndex === this.lowerLimitindex){
            buyIndex = buyIndex -1
        }
        let askIndex = this.askIndex - start;
        if(askIndex < 0) {
            askIndex = 0;
        } 
        
        if( this.askIndex === this.UpperLimitindex){
            askIndex = askIndex +1
        }
        
        if(askIndex  > this.count || askIndex === 0) {
            askIndex = this.count ;
        } 
      
        ctx.fillStyle = BUYBACKGROUND;
        ctx.fillRect(_x, y, buyIndex *barWidth + barWidth,this.height);
        ctx.fillStyle = ASKBACKGROUND;
        ctx.fillRect(_x + askIndex *barWidth, y, this.width- _x - askIndex *barWidth - 30 , this.height);
        for(let i = start; (i-start) <= this.count; i ++ ){
            if(!this.data[i]){
                console.log(i, JSON.parse(JSON.stringify(this.data)))
                continue;
            }
            const { price } = this.data[i];
            const  x = X + 50 + (i - start) * barWidth;
            const y = Y + 10;
            if((price * Math.pow(10, this.decimal)).toFixed()% (this.step * Math.pow(10, this.decimal + 1)) ===0){
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(x, y + 20);                
                ctx.setLineDash([1, 2])
                ctx.lineTo(x, this.height);
                ctx.stroke();
                ctx.restore()
            }
            
        }

    }
    renderPrice(){
        
        const start = this.start;
        const ctx = this.ctx;
        ctx.fillStyle= FONTCOLOR;
        ctx.textAlign = 'left'
        ctx.clearRect(100 , 0 ,this.width ,Y);
        ctx.clearRect(100 , Y+10 ,this.width ,Y+6);
        const barWidth = this.barWidth;
        for(let i = start; (i-start) <= this.count; i ++ ){
            if(!this.data[i]){
                console.log(i, JSON.parse(JSON.stringify(this.data)))
                continue;
            }
            const { price } = this.data[i];
            const  x = X + 50 + (i - start) * barWidth;
            const y = Y + 10;
            if((price * Math.pow(10, this.decimal)).toFixed() % (this.step * Math.pow(10, this.decimal + 1)) ===0){
                ctx.save();
                ctx.fillText(price, x , 20);
                ctx.beginPath();
                ctx.moveTo(x, y );
                ctx.lineTo(x, y + 6);
                ctx.stroke();
                ctx.restore()
            }else{
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x, y + 3);
                ctx.stroke();
            }
             
        }
    }
    renderVolume(){
        const ctx = this.ctx;

        const y = Y + 30;
        const _x = X + 50.5;
        const buyIndex = this.buyIndex;
        const askIndex = this.askIndex;
        const barWidth = this.barWidth;
        let askX,askY, askV, buyX,buY, buyV;
        for(let i = this.start; (i-this.start)  <= this.count; i ++ ){
            if(!this.data[i]){
                console.log(i, JSON.parse(JSON.stringify(this.data)))
                continue;
            }
            const { volum, type, isone} = this.data[i];
            if(i> buyIndex && i<askIndex){
                continue
            }
            
            if(volum){
                if((type === 'buy' && i > buyIndex) || (type ==='ask' && i < askIndex)){
                    continue;
                }
                if(i=== buyIndex && type === 'buy'){
                    ctx.fillStyle= VALUECOLOR['buy1']; 
                }else if(i===askIndex && type === 'ask'){
                    ctx.fillStyle= VALUECOLOR['ask1']; 
                }else{
                    ctx.fillStyle= VALUECOLOR[type]; 
                }
               
                const  x = _x + (i-this.start) * barWidth;
                const height = Chart.getHeight(this.range, volum, this.volumeScaleHeight); 
                ctx.fillRect(x,y,barWidth -1,height);
                
                if(i === askIndex){
                    askX = x + this.volumeXOffset;
                    askY = y;
                    if(this.volumeYOffset < 0){
                        askY = askY - this.volumeYOffset
                    }
                    askV = volum;
                } else if(i === buyIndex ){
                    buyX = x + barWidth - this.volumeXOffset;
                    buY = y;
                    buyV = volum
                    if(this.volumeYOffset > 0){
                        buY = buY + this.volumeYOffset
                    }
                }
            }

        }
        
        ctx.save();
        ctx.font= '12px 宋体';
        ctx.fillStyle= FONTCOLOR;
        if(buyV){
            buyV = buyV 
            ctx.textAlign='right'
            ctx.fillText(buyV, buyX , buY + 10);

        }
        if(askV){
            ctx.textAlign='left'
            ctx.fillText(askV, askX , askY + 10);
        }
        ctx.stroke();
    }
    clearData(startPrice, endPrice){
        if(!startPrice || !endPrice) return;
        let start = this.getindex(startPrice, true);
        if(start < 0) start = 0
        let end = this.getindex(endPrice, true);
        if(end > this.data.length -1) end = this.data.length -1;
        for(let i = start; i < end; i++){
            if(!this.data[i]){
                console.log(i, JSON.parse(JSON.stringify(this.data)))
                continue;
            }
            this.data[i].volum = 0;
        }
    }
    pushData(count){
        let {price} = this.data[this.data.length-1];
        price = parseFloat(price)
        const decimal = this.decimal
        if(count < 5){
            count = 5
        }
        for(let i =1; i <= count; i++ ){
            this.data.push({
                price: (price+ i* this.step).toFixed(decimal)
            })
        }
        this.start = this.start + count;
        
    }
    unshiftData(count){
        let {price} = this.data[0];
        price = parseFloat(price)
        const decimal = this.decimal
        if(count < 5){
            count = 5
        }
        for(let i =1; i <= count; i++ ){
            this.data.unshift({
                price:(price- i* this.step).toFixed(decimal)
            })
        }
        this.start = 0;
        return count
    }
    getindex(price, pure){
        // console.log(price, pure);
        if(Math.abs(price) > Number.MAX_SAFE_INTEGER){
           return undefined
        }
        if(!price) return this.start
        let index = Math.round((price - this.data[0].price) / this.step);
        if(pure){
            return index;
        }
        let barToBorder = parseInt(this.barToBorder);

        let offset = 0;
        let rerender = false;
        
        if(index > this.data.length - barToBorder){
             offset = index - this.data.length + barToBorder;
            this.pushData(offset);
            rerender = true;
        }
        if(index < barToBorder){
            offset = barToBorder - index;
            const count = this.unshiftData(offset)
           
            rerender = true;
            index = index + count;
        }
        const start = this.start;
        if(index < start + barToBorder){
            offset =  barToBorder+start - index;
            let min = offset;
           
            this.start = start - min
            rerender = true;
        }
        if(index > start + this.count - barToBorder){
            offset = index - start- this.count+barToBorder;
            let min = offset;

            this.start = start + min;
            rerender = true;
        }
     
        if(rerender){
            this.renderPrice();
        }
      
        return index;
    }
    renderTime(time){
        const ctx = this.ctx;
        ctx.save();
        ctx.fillStyle = FONTCOLOR;
        ctx.clearRect(0,0, 50, 20);
        ctx.fillText(time, 0, 20);
        ctx.restore();
    }
    renderCurrentPirce(price, volume){
        const ctx =this.ctx;
        ctx.save();
        ctx.setLineDash([]);
        ctx.strokeStyle = FONTCOLOR;

        // console.log(volume, this.volume)
        if(this.volume < volume){
            ctx.strokeStyle = '#ffff00';
        };
        const barWidth = this.barWidth;
        const x = X + 50 + (this.getindex(price, true) - this.start) * barWidth;
     
        ctx.clearRect(0,20,this.width,10)
        ctx.beginPath();
        ctx.moveTo(x, 21);
        ctx.lineTo(x+barWidth, 21);
        ctx.lineTo(x+barWidth, 29);
        ctx.lineTo(x, 29);
        ctx.lineTo(x, 21);
        ctx.stroke()
        ctx.restore();
        this.currentPrice = price;
        this.volume=volume
    }
    renderPlaceOrder(){
        if(this.data.length===0) return;
        
        const pricearray = this.placeOrder.reduce((a, b) => {
            const {LimitPrice, VolumeTotalOriginal, Direction, VolumeTraded, OrderStatus, OrderSysID,StopPrice} =b;
            
            if(OrderStatus !== '3' && OrderStatus!=='1' && OrderStatus!=='b'){
                return a;
            }
            const item = a.find(e=> {
                
                if(e.StopPrice){
                    return e.StopPrice === StopPrice
                }else{
                    return e.price===LimitPrice;  
                }
                 
                          
            })
            if(item){
                item.volume = item.volume + VolumeTotalOriginal -VolumeTraded
            }else{
                a.push({
                    price: LimitPrice,
                    volume: VolumeTotalOriginal -VolumeTraded,
                    direction: Direction,
                    OrderSysID,
                    StopPrice
                })
            }
            return a;
        },[])
        const ctx =this.ctx;
        ctx.save();
        
        const y = Y + 30 ;
        const _x = X + 50.5;
        const {barWidth, volumeScaleHeight, range} = this;
        let _volume = [0, 0];
        
        pricearray.forEach(({price, volume, direction, OrderSysID = '', StopPrice}) => {
            let index 
            console.log(this.start, this.start + this.count)
            const iscondition = OrderSysID.startsWith('TJBD_');
            let color;
            if(iscondition){
                color = 'blue';
                index = this.getindex(StopPrice, true);
            }else{
                index =this.getindex(price, true);
                color= VALUECOLOR.order;
                _volume[direction] = _volume[direction] + volume;
            }
            if(index < this.start || index > this.start + this.count)return;
            const  x = _x + (index-this.start) * barWidth;
            const height = Chart.getHeight(range, volume, volumeScaleHeight); 
            
            ctx.fillStyle = color
            ctx.fillRect(x,y,barWidth -1,height);

        })
        this.holdVolume = _volume;
        // console.log(this.placeOrder, pricearray)
        ctx.restore()
    }
    renderTradeOrder(){
        const _x = X + 50;
        const _y = Y + 17;
        const {price, direction} = this.traded;
        const {ctx , width, start, barWidth} = this;
        if(!this.data.length)return;
        ctx.clearRect(0, _y - 1 , width, 10)
        if(direction && price.length){
            ctx.save();
            const average = price.reduce((a,b)=> a + parseFloat(b), 0) / price.length;
            const index = this.getindex(average, true)- start;
            let cindex;
            if(direction === '0'){
                cindex = this.buyIndex;
                
            }else{
                cindex = this.askIndex;
            }

            cindex = cindex - start;
            let begin, end, _direction;
            if(index <= cindex){
                begin = index;
                end = cindex;
                _direction = '0';
            }else{
                begin = cindex;
                end = index;
                _direction = '1';
            };
            let color
            if(_direction === direction){
                color = VALUECOLOR.profit;
            }else{
                color = VALUECOLOR.deficit;
            }
            if(begin === end){
                color = VALUECOLOR.hold;
            }
            ctx.fillStyle = color;
            ctx.fillRect(_x + begin * barWidth, _y , (end - begin + 1) * barWidth, 7);
            ctx.fillStyle = '#fff';
            ctx.fillText(price.length, _x+cindex * barWidth + 5, _y + 8)
            ctx.restore()
        }
    }
    renderHighandLow(){
        if(this.data.length === 0) return;
        const lowindex = this.getindex(this.LowestPrice, true);
        const highindex = this.getindex(this.HighestPrice, true);
        const {start, ctx, count, barWidth, height} = this;
        let lowX = (lowindex - start) * barWidth;
        let HighX = (highindex - start) * barWidth
        if(lowindex < start || lowindex > start + count){
            lowX =  - 50;
        }
        if(highindex > start + count || highindex < start){
            HighX = this.width - X - 51
        }
        ctx.clearRect(X -1, Y + 29 ,2 , height - 10);
        ctx.clearRect( this.width - 2, Y + 29 ,2 , height - 10);
        const offset= X + 50;
        ctx.save()
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.strokeStyle = VALUECOLOR.low
        ctx.moveTo(lowX+offset, Y + 30);
        ctx.lineTo(lowX+offset,height - 10);
        ctx.stroke();
        ctx.beginPath();
        
        ctx.strokeStyle = VALUECOLOR.high
        ctx.moveTo(HighX+offset, Y + 30);
        ctx.lineTo(HighX+offset,height - 10);
        ctx.stroke();
        ctx.restore();
        this.renderLimited()
    }
    renderLimited(){
    
        const lowindex = this.lowerLimitindex
        const highindex =  this.UpperLimitindex;
   
        const offset= X + 49.5;
        const {start, ctx, count, barWidth, height} = this;
        ctx.save()
        ctx.strokeStyle = VALUECOLOR.limit;
        ctx.lineWidth = 2
        function render(index){
            if(start<=index  && index <=start+count){
                const _X = (index - start) * barWidth;
                ctx.beginPath();
                ctx.moveTo(_X+offset, Y + 30);
                ctx.lineTo(_X+offset,height - 10);
                ctx.stroke();
            }
        };
        render(lowindex);
        render(highindex);
        ctx.restore();
    }
    renderseconds(){
        const time = new Date().getMilliseconds();
        const ctx = this.ctx;
        ctx.save();
        ctx.fillStyle = FONTCOLOR;
        const width = this.width - 20
        ctx.clearRect(width,0, 20, 10);
        ctx.fillText(time, width, 10);
        ctx.restore();
    }
    render(arg){
        
        if(!arg.LastPrice){
            arg.LastPrice = arg.AskPrice1 || arg.BidPrice1
        }
        if(arg.LastPrice > Number.MAX_SAFE_INTEGER) return
        if(this.data.length === 0) {
            console.log(arg.LastPrice)
            this.initData(arg.LastPrice);
            if(!this.data.length) return
            this.renderPrice();
        }
       
        
        this.args= arg
        // this.renderTime(arg.UpdateTime)
        // console.log(arg)
        if(arg.BidPrice5  &&  arg.BidPrice5 <= Number.MAX_SAFE_INTEGER){
            this.clearData(arg.BidPrice5 , arg.BidPrice1 );
        }
        if(arg.AskPrice5  &&  arg.AskPrice5 <= Number.MAX_SAFE_INTEGER){
            this.clearData(arg.AskPrice1 , arg.AskPrice5 );
        }
        let pauseAsk, pasuseBuy;
        for(let i=5; i> 0; i--){
            let buyPirce = arg[`BidPrice${i}`];
            let buyIndex ;
            const flag = this.rendered?i> 1 : i < 5;
            
            if(buyPirce && !pasuseBuy){
                buyIndex = this.getindex(buyPirce, flag)
                const buyData = this.data[buyIndex];
                if(buyData){
                    buyData.volum = arg[`BidVolume${i}`];
                    buyData.type = 'buy';
                }                                        
            }
          
            
            const askPirce = arg[`AskPrice${i}`] ;
            let askIndex;
            if(askPirce && !pauseAsk){
                askIndex = this.getindex(askPirce, flag)
                const askData = this.data[askIndex];
                if(askData){
                    askData.volum = arg[`AskVolume${i}`];
                    askData.type = 'ask';
                }                              
            }
            
            if(i === 1) {
                if(!buyPirce || buyPirce>= Number.MAX_SAFE_INTEGER || buyPirce <= Number.MIN_SAFE_INTEGER){
                    buyIndex = askIndex 
                    pasuseBuy = true;
                }
                if(!askPirce  || askPirce>= Number.MAX_SAFE_INTEGER || askPirce <= Number.MIN_SAFE_INTEGER){
                    askIndex = buyIndex;
                    pauseAsk = true; 
                    
                }
                this.buyIndex = buyIndex;
                this.askIndex = askIndex;
                
            }
        }
        this.lowerLimitPrice = arg.LowerLimitPrice;
        this.UpperLimitPrice = arg.UpperLimitPrice;
        this.lowerLimitindex = this.getindex(arg.LowerLimitPrice, true);
        this.UpperLimitindex = this.getindex(arg.UpperLimitPrice, true);
        if(!arg.BidPrice1){
          
            this.buyIndex = this.lowerLimitindex
        }
        if(!arg.AskPrice1){
           
            this.askIndex = this.UpperLimitindex
        }
        this.LowestPrice = arg.LowestPrice;
        this.HighestPrice = arg.HighestPrice;
       
        this.renderBakcground();
        
        this.renderVolume();
        // this.renderHighandLow()
      
        
        // this.renderCurrentPirce(arg.LastPrice, arg.Volume);
        this.renderPlaceOrder();
        this.renderTradeOrder();
        this.rendered= true;
        // this.renderseconds()

     
    }
}

const elements = {
  environment: document.querySelector("#environment"),
  credentials: document.querySelector("#credentials"),
  marketStatus: document.querySelector("#marketStatus"),
  timeOffset: document.querySelector("#timeOffset"),
  depthConfig: document.querySelector("#depthConfig"),
  marketSymbol: document.querySelector("#marketSymbol"),
  lastUpdateId: document.querySelector("#lastUpdateId"),
  receivedAt: document.querySelector("#receivedAt"),
  spread: document.querySelector("#spread"),
  bidRows: document.querySelector("#bidRows"),
  askRows: document.querySelector("#askRows"),
  orderSymbol: document.querySelector("#orderSymbol"),
  side: document.querySelector("#side"),
  orderType: document.querySelector("#orderType"),
  quantity: document.querySelector("#quantity"),
  price: document.querySelector("#price"),
  cancelSymbol: document.querySelector("#cancelSymbol"),
  orderId: document.querySelector("#orderId"),
  output: document.querySelector("#output"),
};

function printResult(title, result) {
  elements.output.textContent = `${title}\n${JSON.stringify(result, null, 2)}`;
}

function formatError(result) {
  if (result?.ok) {
    return null;
  }

  const error = result?.error || {};
  return [
    error.message || "未知错误",
    error.code !== undefined ? `code=${error.code}` : "",
    error.status !== undefined ? `HTTP=${error.status}` : "",
  ]
    .filter(Boolean)
    .join("；");
}

function renderDepthRows(container, levels) {

  container.replaceChildren();

  for (const level of levels) {
    const row = document.createElement("tr");
    const price = document.createElement("td");
    const quantity = document.createElement("td");

    price.textContent = level.price;
    quantity.textContent = level.quantity;
    row.append(price, quantity);
    container.append(row);
  }
}

async function loadStatus() {
  const result = await window.binance.getStatus();
  const error = formatError(result);

  if (error) {
    printResult("读取状态失败", result);
    return;
  }

  const status = result.data;
  elements.environment.textContent = status.testnet
    ? "Spot Testnet"
    : "Spot Production";
  elements.credentials.textContent =
    status.hasApiKey && status.hasApiSecret ? "已配置" : "未配置";
  elements.timeOffset.textContent = `${status.serverTimeOffsetMs} ms`;
  elements.depthConfig.textContent =
    `${status.depthSpeed} / 快照 ${status.depthSnapshotLimit} 档 / 显示 ${status.depthDisplayLevels} 档`;
}

document
  .querySelector("#syncTimeButton")
  .addEventListener("click", async () => {
    const result = await window.binance.syncTime();
    printResult("服务器时间同步", result);

    if (result.ok) {
      elements.timeOffset.textContent = `${result.data.offsetMs} ms`;
    }
  });

document
  .querySelector("#connectMarketButton")
  .addEventListener("click", async () => {
    const symbol = elements.marketSymbol.value.trim().toUpperCase();
    elements.orderSymbol.value = symbol;
    elements.cancelSymbol.value = symbol;

    const result = await window.binance.connectDepth(symbol);
    printResult("连接增量深度请求", result);
  });

document
  .querySelector("#disconnectMarketButton")
  .addEventListener("click", async () => {
    const result = await window.binance.disconnectMarket();
    printResult("断开行情", result);
  });

document
  .querySelector("#placeOrderButton")
  .addEventListener("click", async () => {
    const type = elements.orderType.value;

    const order = {
      symbol: elements.orderSymbol.value.trim(),
      side: elements.side.value,
      type,
      quantity: elements.quantity.value.trim(),
    };

    if (type === "LIMIT") {
      order.price = elements.price.value.trim();
      order.timeInForce = "GTC";
    }

    const result = await window.binance.placeOrder(order);
    printResult("下单结果", result);

    if (result.ok && result.data.orderId !== undefined) {
      elements.orderId.value = String(result.data.orderId);
      elements.cancelSymbol.value = result.data.symbol;
    }
  });

document
  .querySelector("#cancelOrderButton")
  .addEventListener("click", async () => {
    const result = await window.binance.cancelOrder({
      symbol: elements.cancelSymbol.value.trim(),
      orderId: elements.orderId.value.trim(),
    });

    printResult("撤单结果", result);
  });

elements.orderType.addEventListener("change", () => {
  const isLimit = elements.orderType.value === "LIMIT";
  elements.price.disabled = !isLimit;
});
const chartDom = document.querySelector('#can');
const chart = new Chart(chartDom,980, 300, 0.01,{
    volumeScaleCount: 3,
    volumeScaleHeight: 25,
    volumeScaleTick: 10,
    volumeScaleType: 2,
    volumeXOffset: 2,
    volumeYOffset: 0,
    barLevel: 4,
    barToBorder: 10,
    barVolume: 140,
    barWidth: 13,
    calcBarType: 2

});
window.binance.onDepthUpdate((depth) => {
    
  renderDepthRows(elements.bidRows, depth.bids || []);
  renderDepthRows(elements.askRows, depth.asks || []);
    const data = {

    } 
  if(depth.bids && depth.bids.length){
    for(let i = 0; i<depth.bids.length; i++){
        data[`BidPrice${i+1}` ] = parseFloat(depth.bids[i].price);
         data[`BidVolume${i+1}` ] =  parseFloat(depth.bids[i].quantity);
    }
  }
   if(depth.asks && depth.asks.length){
    for(let i = 0; i<depth.asks.length; i++){
        data[`AskPrice${i+1}` ] = parseFloat(depth.asks[i].price);
         data[`AskVolume${i+1}` ] =  parseFloat(depth.asks[i].quantity);
    }
  }
  chart.render(data);
  const bestBid = depth.bids?.[0]?.price;
  const bestAsk = depth.asks?.[0]?.price;
  const spread =
    bestBid && bestAsk ? Number(bestAsk) - Number(bestBid) : null;

  elements.lastUpdateId.textContent = depth.lastUpdateId ?? "-";
  elements.receivedAt.textContent = new Date(
    depth.receivedAt
  ).toLocaleString();
  elements.spread.textContent =
    spread === null || !Number.isFinite(spread)
      ? "-"
      : String(spread);
});

window.binance.onMarketStatus((status) => {
  elements.marketStatus.textContent = [
    status.status,
    status.symbol || "",
    status.lastUpdateId !== undefined
      ? `updateId=${status.lastUpdateId}`
      : "",
    status.code !== undefined ? `code=${status.code}` : "",
  ]
    .filter(Boolean)
    .join(" / ");
});

window.binance.onMarketError((error) => {
  printResult("行情连接错误", error);
});

loadStatus().catch((error) => {
  printResult("初始化异常", {
    message: error.message,
  });
});
